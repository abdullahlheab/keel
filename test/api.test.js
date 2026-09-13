import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootServer, client } from './helpers.js';

let srv;
let owner; let cofounder; let outsider;
let companyId;
let projectId;
let expenseId;
let taskIds = [];

before(async () => {
  srv = await bootServer({ ALLOW_OPEN_SIGNUP: 'true' });
  owner = client(srv.base);
  cofounder = client(srv.base);
  outsider = client(srv.base);
});
after(async () => { await srv.close(); });

test('health endpoint', async () => {
  const r = await owner.get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('register the first owner and company', async () => {
  const r = await owner.post('/api/auth/register', { name: 'Abdul', email: 'Abdul@Example.com', password: 'correct-horse-battery', companyName: 'Rocket Labs', currency: 'USD' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.user.email, 'abdul@example.com');
  assert.equal(r.data.companies.length, 1);
  assert.equal(r.data.companies[0].role, 'owner');
  assert.equal(r.data.companies[0].key, 'RL');
  companyId = r.data.companies[0].id;
  assert.ok(owner.cookie, 'session cookie set');
  const me = await owner.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.name, 'Abdul');
});

test('weak passwords and bad emails are rejected with field errors', async () => {
  const r = await outsider.post('/api/auth/register', { name: 'X', email: 'not-an-email', password: 'short', companyName: 'Y' });
  assert.equal(r.status, 400);
  assert.ok(r.data.fields.email);
  assert.ok(r.data.fields.password);
});

test('mutating requests without the CSRF header are refused', async () => {
  const r = await owner.post('/api/projects', { name: 'x' }, { noCsrf: true });
  assert.equal(r.status, 403);
});

test('security headers are present', async () => {
  const r = await owner.get('/api/health');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('login: wrong password is rejected, right one works', async () => {
  const bad = await cofounder.post('/api/auth/login', { email: 'abdul@example.com', password: 'nope-nope-nope' });
  assert.equal(bad.status, 401);
  const unknown = await cofounder.post('/api/auth/login', { email: 'ghost@example.com', password: 'nope-nope-nope' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.data.error, bad.data.error, 'same message for unknown email and wrong password');
  const ok = await cofounder.post('/api/auth/login', { email: 'abdul@example.com', password: 'correct-horse-battery' });
  assert.equal(ok.status, 200);
  await cofounder.post('/api/auth/logout');
  cofounder.clearCookie();
});

test('invite flow brings in the co-founder as admin', async () => {
  const inv = await owner.post('/api/company/invites', { email: 'sam@example.com', role: 'admin' });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  assert.match(inv.data.url, /\/invite\/[A-Za-z0-9_-]{40,}$/);
  const token = inv.data.url.split('/invite/')[1];

  const info = await cofounder.get(`/api/auth/invites/${token}`);
  assert.equal(info.status, 200);
  assert.equal(info.data.companyName, 'Rocket Labs');
  assert.equal(info.data.state, 'valid');

  const wrongEmail = await cofounder.post(`/api/auth/invites/${token}/accept`, { name: 'Sam', email: 'other@example.com', password: 'another-long-password' });
  assert.equal(wrongEmail.status, 400);

  const accept = await cofounder.post(`/api/auth/invites/${token}/accept`, { name: 'Sam', email: 'sam@example.com', password: 'another-long-password' });
  assert.equal(accept.status, 200, JSON.stringify(accept.data));
  assert.equal(accept.data.companies[0].role, 'admin');

  const again = await outsider.get(`/api/auth/invites/${token}`);
  assert.equal(again.data.state, 'accepted');

  const company = await owner.get('/api/company');
  assert.equal(company.data.members.length, 2);
  assert.ok(company.data.categories.length >= 5, 'default categories seeded');
});

test('an outsider with their own company cannot see ours', async () => {
  const r = await outsider.post('/api/auth/register', { name: 'Eve', email: 'eve@evil.com', password: 'evil-long-password', companyName: 'Evil Corp' });
  assert.equal(r.status, 201);
  const spy = await outsider.get('/api/projects', { headers: { 'X-Company-Id': companyId } });
  assert.equal(spy.status, 403);
  const own = await outsider.get('/api/company');
  assert.equal(own.data.company.name, 'Evil Corp');
});

test('projects: create, read, update, stats', async () => {
  const c = await owner.post('/api/projects', { name: 'Secret Rocket', description: 'Top secret launch vehicle', budget: '25,000.00', color: '#eb6834', status: 'active' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  projectId = c.data.id;
  assert.equal(c.data.budgetCents, 2500000);
  assert.equal(c.data.spentCents, 0);

  const bad = await owner.post('/api/projects', { name: '', budget: 'abc' });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.fields.name && bad.data.fields.budget);

  const u = await cofounder.patch(`/api/projects/${projectId}`, { status: 'on_hold' });
  assert.equal(u.status, 200);
  assert.equal(u.data.status, 'on_hold');
  await cofounder.patch(`/api/projects/${projectId}`, { status: 'active' });

  const list = await owner.get('/api/projects');
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.items[0].name, 'Secret Rocket');
});

test('expenses: create, filter, summary, export', async () => {
  const cats = (await owner.get('/api/company/categories')).data.items;
  const cloud = cats.find((c) => /cloud/i.test(c.name));
  const me = (await owner.get('/api/auth/me')).data.user;
  const sam = (await cofounder.get('/api/auth/me')).data.user;
  const today = new Date().toISOString().slice(0, 10);
  const lastYear = `${new Date().getUTCFullYear() - 1}-06-15`;

  const e1 = await owner.post('/api/expenses', { amount: '1200.50', date: today, projectId, categoryId: cloud.id, vendor: 'AWS', description: 'Compute for launch sims', paidByUserId: me.id, paymentMethod: 'card', recurring: 'monthly' });
  assert.equal(e1.status, 201, JSON.stringify(e1.data));
  expenseId = e1.data.id;
  assert.equal(e1.data.amountCents, 120050);
  assert.equal(e1.data.currency, 'USD');

  const e2 = await cofounder.post('/api/expenses', { amount: 300, date: today, projectId, vendor: 'Figma', paidByUserId: sam.id, status: 'pending' });
  assert.equal(e2.status, 201);
  const e3 = await owner.post('/api/expenses', { amount: '99.99', date: lastYear, vendor: 'Notion', description: 'Company wiki' });
  assert.equal(e3.status, 201);

  const all = await owner.get('/api/expenses');
  assert.equal(all.data.total, 3);
  assert.equal(all.data.sumCents, 120050 + 30000 + 9999);
  const byProject = await owner.get(`/api/expenses?project=${projectId}`);
  assert.equal(byProject.data.total, 2);
  const noProject = await owner.get('/api/expenses?project=none');
  assert.equal(noProject.data.total, 1);
  const search = await owner.get('/api/expenses?q=wiki');
  assert.equal(search.data.items[0].vendor, 'Notion');

  const summary = await owner.get('/api/expenses/summary');
  assert.equal(summary.status, 200);
  assert.equal(summary.data.totals.allTimeCents, 160049);
  assert.equal(summary.data.totals.thisMonthCents, 150050);
  assert.equal(summary.data.totals.pendingCents, 30000);
  assert.equal(summary.data.byProject.find((p) => p.projectId === projectId).cents, 150050);
  assert.equal(summary.data.byPayer.find((p) => p.userId === sam.id).cents, 30000);
  assert.equal(summary.data.byMonth.length, 12);
  assert.equal(summary.data.byMonth[11].cents, 150050);
  assert.equal(summary.data.budgets[0].spentCents, 150050);
  assert.equal(summary.data.totals.recurringMonthlyCents, 120050);

  const proj = await owner.get(`/api/projects/${projectId}`);
  assert.equal(proj.data.project.spentCents, 150050);
  assert.equal(proj.data.expenses.length, 2);

  const csv = await owner.get('/api/expenses/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /AWS/);
  assert.match(csv.data, /1200\.50/);
  assert.match(csv.data, /Secret Rocket/);
});

test('members can only edit their own expenses; admins can edit all', async () => {
  const inv = await owner.post('/api/company/invites', { role: 'member' });
  const token = inv.data.url.split('/invite/')[1];
  const member = client(srv.base);
  const acc = await member.post(`/api/auth/invites/${token}/accept`, { name: 'Mo', email: 'mo@example.com', password: 'member-long-password' });
  assert.equal(acc.status, 200);
  const denied = await member.patch(`/api/expenses/${expenseId}`, { vendor: 'Hacked' });
  assert.equal(denied.status, 403);
  const deniedCompany = await member.patch('/api/company', { name: 'Hacked' });
  assert.equal(deniedCompany.status, 403);
  const deniedDelete = await member.del(`/api/projects/${projectId}`);
  assert.equal(deniedDelete.status, 403);
  const own = await member.post('/api/expenses', { amount: 10, date: '2026-01-05', vendor: 'Coffee' });
  assert.equal(own.status, 201);
  const edit = await member.patch(`/api/expenses/${own.data.id}`, { vendor: 'Better Coffee' });
  assert.equal(edit.status, 200);
  const adminEdit = await cofounder.patch(`/api/expenses/${own.data.id}`, { status: 'reimbursed' });
  assert.equal(adminEdit.status, 200);
  await member.del(`/api/expenses/${own.data.id}`);
  await owner.del(`/api/company/members/${acc.data.user.id}`);
  const members = await owner.get('/api/company/members');
  assert.equal(members.data.items.length, 2);
});

test('receipts are encrypted on disk and round-trip intact', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('RECEIPT-PLAINTEXT-MARKER-1234567890'.repeat(20))]);
  const up = await owner.post(`/api/expenses/${expenseId}/receipts`, new Uint8Array(png), { headers: { 'Content-Type': 'image/png', 'X-Filename': 'aws%20invoice.png' } });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.filename, 'aws invoice.png');
  assert.equal(up.data.size, png.length);

  const files = fs.readdirSync(path.join(srv.dataDir, 'uploads'));
  assert.equal(files.length, 1);
  const onDisk = fs.readFileSync(path.join(srv.dataDir, 'uploads', files[0]));
  assert.ok(!onDisk.includes('RECEIPT-PLAINTEXT-MARKER'), 'receipt is not stored in plaintext');
  assert.ok(!onDisk.subarray(0, 8).equals(png.subarray(0, 8)), 'png header not visible');

  const down = await owner.get(`/api/receipts/${up.data.id}`, { raw: true });
  assert.equal(down.status, 200);
  assert.ok(Buffer.from(down.data).equals(png), 'decrypted bytes identical');
  assert.equal(down.headers.get('content-type'), 'image/png');

  const rejected = await owner.post(`/api/expenses/${expenseId}/receipts`, new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'application/x-msdownload' } });
  assert.equal(rejected.status, 415);

  const outsiderRead = await outsider.get(`/api/receipts/${up.data.id}`);
  assert.equal(outsiderRead.status, 404);
});

test('sensitive fields are encrypted in the database file', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(srv.dataDir, 'tracker.sqlite'), { readOnly: true });
  const p = raw.prepare('SELECT name_enc, description_enc, budget_cents_enc FROM projects').get();
  assert.ok(p.name_enc.startsWith('v1.'));
  assert.ok(!p.name_enc.includes('Secret Rocket'));
  assert.ok(!p.description_enc.includes('secret'));
  assert.ok(!p.budget_cents_enc.includes('2500000'));
  const e = raw.prepare('SELECT vendor_enc, amount_cents_enc, description_enc FROM expenses').all();
  for (const row of e) {
    assert.ok(!(row.vendor_enc || '').includes('AWS'));
    assert.ok(!(row.amount_cents_enc || '').includes('120050'));
  }
  const s = raw.prepare('SELECT token_hash FROM sessions').get();
  assert.match(s.token_hash, /^[0-9a-f]{64}$/);
  const u = raw.prepare('SELECT password_hash FROM users').get();
  assert.match(u.password_hash, /^scrypt\$15\$8\$1\$/);
  raw.close();

  const dump = fs.readFileSync(path.join(srv.dataDir, 'tracker.sqlite'));
  assert.ok(!dump.includes('Secret Rocket'), 'project name not in db file');
  assert.ok(!dump.includes('Compute for launch sims'), 'expense description not in db file');
  assert.ok(!dump.includes('correct-horse-battery'), 'password not in db file');
});

test('tasks: create, order, move, comments, completion', async () => {
  const me = (await owner.get('/api/auth/me')).data.user;
  for (const [title, status] of [['Design the engine', 'todo'], ['Order parts', 'todo'], ['Write pitch deck', 'backlog']]) {
    const r = await owner.post('/api/tasks', { title, status, projectId, priority: 'high', assigneeUserId: me.id, labels: ['launch'], checklist: [{ text: 'first step' }, { text: '', done: true }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    taskIds.push(r.data.id);
  }
  const list = await owner.get('/api/tasks');
  assert.equal(list.data.items.length, 3);
  const numbers = list.data.items.map((t) => t.number).sort();
  assert.deepEqual(numbers, [1, 2, 3]);
  const first = list.data.items.find((t) => t.id === taskIds[0]);
  assert.equal(first.checklist.length, 1, 'blank checklist items dropped');
  assert.deepEqual(first.labels, ['launch']);

  // Move "Order parts" to the top of todo
  const mv = await cofounder.post(`/api/tasks/${taskIds[1]}/move`, { status: 'todo', index: 0 });
  assert.equal(mv.status, 200);
  const todo = (await owner.get('/api/tasks?status=todo')).data.items;
  assert.deepEqual(todo.map((t) => t.id), [taskIds[1], taskIds[0]]);

  // Move to done sets completedAt
  const done = await owner.post(`/api/tasks/${taskIds[2]}/move`, { status: 'done', index: 0 });
  assert.equal(done.data.status, 'done');
  assert.ok(done.data.completedAt);
  const reopened = await owner.patch(`/api/tasks/${taskIds[2]}`, { status: 'backlog' });
  assert.equal(reopened.data.completedAt, null);

  const c = await cofounder.post(`/api/tasks/${taskIds[0]}/comments`, { body: 'Let us use titanium' });
  assert.equal(c.status, 201);
  const detail = await owner.get(`/api/tasks/${taskIds[0]}`);
  assert.equal(detail.data.comments.length, 1);
  assert.equal(detail.data.comments[0].body, 'Let us use titanium');
  const ownerEditsOthers = await owner.patch(`/api/tasks/${taskIds[0]}/comments/${c.data.id}`, { body: 'edited' });
  assert.equal(ownerEditsOthers.status, 200);

  const bySearch = await owner.get('/api/tasks?q=rl-2');
  assert.equal(bySearch.data.items.length, 1);
  assert.equal(bySearch.data.items[0].number, 2);
});

test('activity feed records what happened', async () => {
  const r = await owner.get('/api/activity?limit=100');
  assert.equal(r.status, 200);
  const summaries = r.data.items.map((a) => a.summary);
  assert.ok(summaries.some((s) => /created project "Secret Rocket"/.test(s)));
  assert.ok(summaries.some((s) => /moved RL-\d+ to Done/.test(s)));
  assert.ok(summaries.some((s) => /Sam joined as admin/.test(s)));
  assert.ok(r.data.items.every((a) => a.userName));
});

test('two-factor: setup, enable, login challenge, recovery code, disable', async () => {
  const { totpCode } = await import('../server/crypto.js');
  const setup = await cofounder.post('/api/auth/me/mfa/setup', { password: 'another-long-password' });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  assert.match(setup.data.qrDataUrl, /^data:image\/png;base64,/);
  const wrong = await cofounder.post('/api/auth/me/mfa/enable', { code: '000000' });
  assert.equal(wrong.status, 400);
  const enable = await cofounder.post('/api/auth/me/mfa/enable', { code: totpCode(setup.data.secret) });
  assert.equal(enable.status, 200, JSON.stringify(enable.data));
  assert.equal(enable.data.recoveryCodes.length, 8);

  await cofounder.post('/api/auth/logout');
  cofounder.clearCookie();
  const login = await cofounder.post('/api/auth/login', { email: 'sam@example.com', password: 'another-long-password' });
  assert.equal(login.status, 200);
  assert.equal(login.data.mfaRequired, true);
  const blocked = await cofounder.get('/api/auth/me');
  assert.equal(blocked.status, 401);
  assert.equal(blocked.data.mfaRequired, true);
  const blockedData = await cofounder.get('/api/projects');
  assert.equal(blockedData.status, 401);
  const badCode = await cofounder.post('/api/auth/mfa', { code: '123456' });
  assert.equal(badCode.status, 401);
  const good = await cofounder.post('/api/auth/mfa', { code: totpCode(setup.data.secret) });
  assert.equal(good.status, 200);
  assert.equal((await cofounder.get('/api/auth/me')).status, 200);

  // recovery code path
  await cofounder.post('/api/auth/logout');
  cofounder.clearCookie();
  await cofounder.post('/api/auth/login', { email: 'sam@example.com', password: 'another-long-password' });
  const rec = await cofounder.post('/api/auth/mfa', { code: enable.data.recoveryCodes[0] });
  assert.equal(rec.status, 200);
  await cofounder.post('/api/auth/logout');
  cofounder.clearCookie();
  await cofounder.post('/api/auth/login', { email: 'sam@example.com', password: 'another-long-password' });
  const reused = await cofounder.post('/api/auth/mfa', { code: enable.data.recoveryCodes[0] });
  assert.equal(reused.status, 401, 'recovery codes are single use');
  await cofounder.post('/api/auth/mfa', { code: totpCode(setup.data.secret) });

  const disable = await cofounder.post('/api/auth/me/mfa/disable', { password: 'another-long-password', code: totpCode(setup.data.secret) });
  assert.equal(disable.status, 200);
  assert.equal((await cofounder.get('/api/auth/me')).data.user.totpEnabled, false);
});

test('sessions: list, revoke others, password change logs out other devices', async () => {
  const other = client(srv.base);
  await other.post('/api/auth/login', { email: 'abdul@example.com', password: 'correct-horse-battery' });
  const list = await owner.get('/api/auth/me/sessions');
  assert.ok(list.data.items.length >= 2);
  assert.equal(list.data.items.filter((s) => s.current).length, 1);
  const pw = await owner.post('/api/auth/me/password', { currentPassword: 'correct-horse-battery', newPassword: 'even-better-password-2' });
  assert.equal(pw.status, 200);
  assert.equal((await other.get('/api/auth/me')).status, 401, 'other device signed out');
  assert.equal((await owner.get('/api/auth/me')).status, 200, 'this device stays signed in');
});

test('owner protections: last owner cannot leave or be demoted', async () => {
  const me = (await owner.get('/api/auth/me')).data.user;
  const demote = await owner.patch(`/api/company/members/${me.id}`, { role: 'member' });
  assert.equal(demote.status, 409);
  const leave = await owner.del(`/api/company/members/${me.id}`);
  assert.equal(leave.status, 409);
  const sam = (await cofounder.get('/api/auth/me')).data.user;
  const adminPromotes = await cofounder.patch(`/api/company/members/${sam.id}`, { role: 'owner' });
  assert.equal(adminPromotes.status, 403, 'admins cannot make owners');
  const ownerPromotes = await owner.patch(`/api/company/members/${sam.id}`, { role: 'owner' });
  assert.equal(ownerPromotes.status, 200);
});

test('rate limiter blocks after the configured number of hits', async () => {
  const { rateLimit } = await import('../server/middleware/security.js');
  const limiter = rateLimit({ windowMs: 1000, max: 3 });
  let blocked = 0;
  for (let i = 0; i < 5; i++) limiter({ ip: '1.2.3.4' }, { setHeader() {} }, (err) => { if (err) blocked += 1; });
  assert.equal(blocked, 2);
});

test('SPA fallback serves index.html for app routes, not for API', async () => {
  const page = await owner.get('/projects/abc');
  assert.equal(page.status, 200);
  assert.match(page.data, /id="app"/);
  const missing = await owner.get('/api/nothing-here');
  assert.equal(missing.status, 404);
});
