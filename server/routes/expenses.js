// Expenses, encrypted receipts, company-wide summary, CSV export.
import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, tx, now, one, all } from '../db.js';
import { uid, encrypt, encryptInt, encryptBuffer, decryptBuffer, randomToken } from '../crypto.js';
import { validate, rules } from '../validate.js';
import { HttpError, notFound, forbidden } from '../middleware/errors.js';
import { hasRole } from '../middleware/auth.js';
import { logActivity } from '../services/activity.js';
import { expenseRow, receiptRow, listExpensesRaw, listProjects, getMembers, monthKey, centsToDecimal } from '../services/repo.js';

const router = Router();
const STATUSES = ['pending', 'paid', 'reimbursed'];
const METHODS = ['card', 'bank', 'cash', 'other'];
const RECURRING = ['monthly', 'yearly'];
const RECEIPT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'application/pdf']);

const schema = {
  amount: rules.money({ required: true }),
  currency: rules.string({ pattern: /^[A-Z]{3}$/, message: 'Use a 3-letter code like USD' }),
  date: rules.date({ required: true }),
  projectId: rules.id(),
  categoryId: rules.id(),
  vendor: rules.string({ max: 120 }),
  description: rules.string({ max: 500 }),
  notes: rules.string({ max: 5000 }),
  paymentMethod: rules.enum(METHODS),
  paidByUserId: rules.id(),
  status: rules.enum(STATUSES, { default: 'paid' }),
  recurring: rules.enum(RECURRING),
};

function fmtMoney(cents, currency) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100); } catch { return `${centsToDecimal(cents)} ${currency}`; }
}

function checkRefs(companyId, body) {
  if (body.projectId && !one('SELECT id FROM projects WHERE id = ? AND company_id = ?', body.projectId, companyId)) throw new HttpError(400, 'Please fix the highlighted fields', { fields: { projectId: 'Unknown project' } });
  if (body.categoryId && !one('SELECT id FROM categories WHERE id = ? AND company_id = ?', body.categoryId, companyId)) throw new HttpError(400, 'Please fix the highlighted fields', { fields: { categoryId: 'Unknown category' } });
  if (body.paidByUserId && !one('SELECT id FROM memberships WHERE user_id = ? AND company_id = ?', body.paidByUserId, companyId)) throw new HttpError(400, 'Please fix the highlighted fields', { fields: { paidByUserId: 'Not a member' } });
}

function canEdit(req, expense) {
  return hasRole(req, 'admin') || expense.createdBy === req.user.id || expense.paidByUserId === req.user.id;
}

function applyFilters(items, q) {
  let out = items;
  if (q.ids) { const wanted = new Set(String(q.ids).split(',')); out = out.filter((e) => wanted.has(e.id)); }
  if (q.project === 'none') out = out.filter((e) => !e.projectId);
  else if (q.project) out = out.filter((e) => e.projectId === q.project);
  if (q.category === 'none') out = out.filter((e) => !e.categoryId);
  else if (q.category) out = out.filter((e) => e.categoryId === q.category);
  if (q.paidBy) out = out.filter((e) => e.paidByUserId === q.paidBy);
  if (q.status) out = out.filter((e) => e.status === q.status);
  if (q.from) out = out.filter((e) => e.date >= q.from);
  if (q.to) out = out.filter((e) => e.date <= q.to);
  if (q.updatedSince) out = out.filter((e) => e.updatedAt > String(q.updatedSince));
  if (q.q) {
    const needle = String(q.q).toLowerCase();
    out = out.filter((e) => [e.vendor, e.description, e.notes].some((s) => s && s.toLowerCase().includes(needle)));
  }
  return out;
}

function receiptsFor(expenseIds) {
  if (!expenseIds.length) return new Map();
  const map = new Map();
  const placeholders = expenseIds.map(() => '?').join(',');
  for (const r of all(`SELECT * FROM receipts WHERE expense_id IN (${placeholders})`, ...expenseIds)) {
    if (!map.has(r.expense_id)) map.set(r.expense_id, []);
    map.get(r.expense_id).push(receiptRow(r));
  }
  return map;
}

router.get('/expenses', (req, res) => {
  const filtered = applyFilters(listExpensesRaw(req.company.id), req.query);
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const page = filtered.slice(offset, offset + limit);
  const receipts = receiptsFor(page.map((e) => e.id));
  res.json({
    items: page.map((e) => ({ ...e, receipts: receipts.get(e.id) || [] })),
    total: filtered.length,
    sumCents: filtered.reduce((s, e) => s + (e.amountCents || 0), 0),
  });
});

router.get('/expenses/summary', (req, res) => {
  const companyId = req.company.id;
  const everything = listExpensesRaw(companyId);
  const ranged = applyFilters(everything, { from: req.query.from, to: req.query.to, project: req.query.project });
  const projects = new Map(listProjects(companyId).map((p) => [p.id, p]));
  const categories = new Map(all('SELECT * FROM categories WHERE company_id = ?', companyId).map((c) => [c.id, c]));
  const members = new Map(getMembers(companyId).map((m) => [m.id, m]));

  const today = new Date();
  const thisMonth = today.toISOString().slice(0, 7);
  const lastMonthDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const lastMonth = lastMonthDate.toISOString().slice(0, 7);
  const year = today.toISOString().slice(0, 4);
  const sum = (arr) => arr.reduce((s, e) => s + (e.amountCents || 0), 0);

  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const byMonthMap = Object.fromEntries(months.map((m) => [m, { month: m, cents: 0, count: 0 }]));
  for (const e of everything) {
    const k = monthKey(e.date);
    if (byMonthMap[k]) { byMonthMap[k].cents += e.amountCents || 0; byMonthMap[k].count += 1; }
  }

  const group = (arr, keyFn, describe) => {
    const map = new Map();
    for (const e of arr) {
      const k = keyFn(e) ?? '__none__';
      if (!map.has(k)) map.set(k, { key: k === '__none__' ? null : k, cents: 0, count: 0, ...describe(k === '__none__' ? null : k) });
      const g = map.get(k);
      g.cents += e.amountCents || 0;
      g.count += 1;
    }
    return [...map.values()].sort((a, b) => b.cents - a.cents);
  };

  const byProject = group(ranged, (e) => e.projectId, (id) => {
    const p = id ? projects.get(id) : null;
    return { projectId: id, name: p ? p.name : (id ? 'Deleted project' : 'No project'), color: p ? p.color : '#898781', budgetCents: p ? p.budgetCents : null, status: p ? p.status : null };
  });
  const byCategory = group(ranged, (e) => e.categoryId, (id) => {
    const c = id ? categories.get(id) : null;
    return { categoryId: id, name: c ? c.name : 'Uncategorised', color: c ? c.color : '#898781' };
  });
  const byPayer = group(ranged, (e) => e.paidByUserId, (id) => {
    const m = id ? members.get(id) : null;
    return { userId: id, name: m ? m.name : (id ? 'Former member' : 'Company account'), avatarColor: m ? m.avatarColor : null };
  });
  const byStatus = group(ranged, (e) => e.status, (s) => ({ status: s }));
  const topVendors = group(ranged.filter((e) => e.vendor), (e) => e.vendor.trim().toLowerCase(), (k) => ({ vendor: ranged.find((e) => e.vendor && e.vendor.trim().toLowerCase() === k)?.vendor.trim() })).slice(0, 8);

  const monthlyRecurring = everything.filter((e) => e.recurring === 'monthly');
  const yearlyRecurring = everything.filter((e) => e.recurring === 'yearly');
  const recurringSeen = new Set();
  let recurringMonthlyCents = 0;
  for (const e of [...monthlyRecurring, ...yearlyRecurring]) {
    const key = `${e.recurring}:${(e.vendor || e.description || e.id).toLowerCase()}`;
    if (recurringSeen.has(key)) continue; // count each subscription once (latest entry first)
    recurringSeen.add(key);
    recurringMonthlyCents += e.recurring === 'monthly' ? (e.amountCents || 0) : Math.round((e.amountCents || 0) / 12);
  }

  res.json({
    currency: req.company.currency,
    totals: {
      allTimeCents: sum(everything),
      count: everything.length,
      thisMonthCents: sum(everything.filter((e) => monthKey(e.date) === thisMonth)),
      lastMonthCents: sum(everything.filter((e) => monthKey(e.date) === lastMonth)),
      ytdCents: sum(everything.filter((e) => e.date.startsWith(year))),
      pendingCents: sum(everything.filter((e) => e.status === 'pending')),
      pendingCount: everything.filter((e) => e.status === 'pending').length,
      rangeCents: sum(ranged),
      rangeCount: ranged.length,
      recurringMonthlyCents,
    },
    byMonth: months.map((m) => byMonthMap[m]),
    byProject,
    byCategory,
    byPayer,
    byStatus,
    topVendors,
    budgets: [...projects.values()].filter((p) => p.budgetCents != null && p.status !== 'archived').map((p) => ({
      projectId: p.id, name: p.name, color: p.color, budgetCents: p.budgetCents,
      spentCents: sum(everything.filter((e) => e.projectId === p.id)),
    })),
  });
});

router.get('/expenses/export.csv', (req, res) => {
  const items = applyFilters(listExpensesRaw(req.company.id), req.query);
  const projects = new Map(listProjects(req.company.id).map((p) => [p.id, p.name]));
  const categories = new Map(all('SELECT id, name FROM categories WHERE company_id = ?', req.company.id).map((c) => [c.id, c.name]));
  const members = new Map(getMembers(req.company.id).map((m) => [m.id, m.name]));
  // A cell that starts with = + - @ (or a tab/carriage return, which spreadsheets strip before they
  // decide) is executed as a formula by Excel, Sheets and LibreOffice. An apostrophe forces it to be
  // text. Plain numbers are exempt, so a negative amount stays a number rather than becoming text.
  const FORMULA_LEAD = /^[=+\-@\t\r]/;
  const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['Date', 'Amount', 'Currency', 'Vendor', 'Description', 'Category', 'Project', 'Paid by', 'Status', 'Payment method', 'Recurring', 'Notes'].join(',')];
  for (const e of items) {
    lines.push([e.date, centsToDecimal(e.amountCents || 0), e.currency, e.vendor, e.description, categories.get(e.categoryId) || '', projects.get(e.projectId) || '', members.get(e.paidByUserId) || '', e.status, e.paymentMethod || '', e.recurring || '', e.notes].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="expenses-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(String.fromCharCode(0xFEFF) + lines.join(String.fromCharCode(13, 10)));
});

router.post('/expenses', (req, res) => {
  const body = validate(schema, req.body);
  checkRefs(req.company.id, body);
  const id = uid();
  const ts = now();
  const currency = body.currency || req.company.currency;
  db.prepare(`INSERT INTO expenses (id, company_id, project_id, category_id, amount_cents_enc, currency, date, vendor_enc, description_enc, notes_enc, payment_method, paid_by_user_id, status, recurring, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.company.id, body.projectId ?? null, body.categoryId ?? null, encryptInt(body.amount), currency, body.date, encrypt(body.vendor ?? null), encrypt(body.description ?? null), encrypt(body.notes ?? null), body.paymentMethod ?? null, body.paidByUserId ?? null, body.status, body.recurring ?? null, req.user.id, ts, ts);
  const projectName = body.projectId ? listProjects(req.company.id).find((p) => p.id === body.projectId)?.name : null;
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'created', entityType: 'expense', entityId: id, summary: `${req.user.name} added a ${fmtMoney(body.amount, currency)} expense${body.vendor ? ` at ${body.vendor}` : ''}${projectName ? ` to ${projectName}` : ''}` });
  res.status(201).json({ ...expenseRow(one('SELECT * FROM expenses WHERE id = ?', id)), receipts: [] });
});

// ---------- bulk actions on a selection ----------
router.post('/expenses/bulk', (req, res) => {
  const body = validate({ ids: rules.array(rules.id(), { required: true, max: 500 }), action: rules.enum(['update', 'delete'], { required: true }) }, req.body);
  const ids = [...new Set(body.ids)];
  if (!ids.length) throw new HttpError(400, 'Select at least one expense');
  const data = req.body.data && typeof req.body.data === 'object' && !Array.isArray(req.body.data) ? req.body.data : {};
  const placeholders = ids.map(() => '?').join(',');
  const found = new Map(all(`SELECT * FROM expenses WHERE company_id = ? AND id IN (${placeholders})`, req.company.id, ...ids).map((r) => [r.id, expenseRow(r)]));
  if (found.size !== ids.length) throw notFound('One or more expenses');
  const rows = ids.map((id) => found.get(id));
  if (rows.some((e) => !canEdit(req, e))) throw forbidden('You can only change expenses you added or paid for');
  const ts = now();
  const n = rows.length;
  const total = fmtMoney(rows.reduce((s, e) => s + (e.amountCents || 0), 0), req.company.currency);
  const noun = `${n} expense${n === 1 ? '' : 's'} (${total})`;
  const log = (action, summary) => logActivity({ companyId: req.company.id, userId: req.user.id, action, entityType: 'expense', entityId: n === 1 ? rows[0].id : null, summary: `${req.user.name} ${summary}`, meta: { ids } });

  if (body.action === 'delete') {
    const files = all(`SELECT stored_name FROM receipts WHERE expense_id IN (${placeholders})`, ...ids);
    tx(() => { const del = db.prepare('DELETE FROM expenses WHERE id = ?'); for (const e of rows) del.run(e.id); });
    for (const f of files) fs.rm(path.join(config.dataDir, 'uploads', f.stored_name), { force: true }, () => {});
    log('deleted', `deleted ${noun}`);
    return res.json({ deleted: n });
  }

  const patch = validate({ status: rules.enum(STATUSES), categoryId: rules.id(), projectId: rules.id(), paidByUserId: rules.id(), paymentMethod: rules.enum(METHODS), recurring: rules.enum(RECURRING), date: rules.date() }, data, { partial: true });
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change');
  checkRefs(req.company.id, patch);
  tx(() => {
    const upd = db.prepare('UPDATE expenses SET status = ?, category_id = ?, project_id = ?, paid_by_user_id = ?, payment_method = ?, recurring = ?, date = ?, updated_at = ? WHERE id = ?');
    for (const e of rows) {
      upd.run(patch.status ?? e.status, 'categoryId' in patch ? patch.categoryId : e.categoryId, 'projectId' in patch ? patch.projectId : e.projectId,
        'paidByUserId' in patch ? patch.paidByUserId : e.paidByUserId, 'paymentMethod' in patch ? patch.paymentMethod : e.paymentMethod,
        'recurring' in patch ? patch.recurring : e.recurring, patch.date ?? e.date, ts, e.id);
    }
  });
  let summary = `updated ${noun}`;
  if (patch.status) summary = `marked ${noun} as ${patch.status}`;
  else if ('categoryId' in patch) summary = patch.categoryId ? `categorised ${noun} as ${one('SELECT name FROM categories WHERE id = ?', patch.categoryId)?.name || ''}` : `removed the category from ${noun}`;
  else if ('projectId' in patch) summary = patch.projectId ? `moved ${noun} to project "${listProjects(req.company.id).find((p) => p.id === patch.projectId)?.name || ''}"` : `removed ${noun} from their project`;
  else if ('paidByUserId' in patch) summary = patch.paidByUserId ? `set ${noun} as paid by ${one('SELECT name FROM users WHERE id = ?', patch.paidByUserId)?.name || 'a member'}` : `set ${noun} as paid from the company account`;
  else if ('recurring' in patch) summary = patch.recurring ? `tagged ${noun} as recurring ${patch.recurring}` : `untagged ${noun} as recurring`;
  log('updated', summary);
  const receipts = receiptsFor(ids);
  res.json({ items: ids.map((id) => ({ ...expenseRow(one('SELECT * FROM expenses WHERE id = ?', id)), receipts: receipts.get(id) || [] })) });
});

router.get('/expenses/:id', (req, res) => {
  const row = one('SELECT * FROM expenses WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!row) throw notFound('Expense');
  res.json({ ...expenseRow(row), receipts: receiptsFor([row.id]).get(row.id) || [] });
});

router.patch('/expenses/:id', (req, res) => {
  const row = one('SELECT * FROM expenses WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!row) throw notFound('Expense');
  const current = expenseRow(row);
  if (!canEdit(req, current)) throw forbidden('Only the person who added this expense or an admin can edit it');
  const body = validate(schema, req.body, { partial: true });
  checkRefs(req.company.id, body);
  const next = { ...current, ...body };
  if ('amount' in body) next.amountCents = body.amount;
  db.prepare(`UPDATE expenses SET project_id = ?, category_id = ?, amount_cents_enc = ?, currency = ?, date = ?, vendor_enc = ?, description_enc = ?, notes_enc = ?, payment_method = ?, paid_by_user_id = ?, status = ?, recurring = ?, updated_at = ? WHERE id = ?`)
    .run(next.projectId ?? null, next.categoryId ?? null, encryptInt(next.amountCents), next.currency, next.date, encrypt(next.vendor ?? null), encrypt(next.description ?? null), encrypt(next.notes ?? null), next.paymentMethod ?? null, next.paidByUserId ?? null, next.status, next.recurring ?? null, now(), row.id);
  const verb = body.status && Object.keys(body).length === 1 ? `marked a ${fmtMoney(next.amountCents, next.currency)} expense as ${body.status}` : `updated a ${fmtMoney(next.amountCents, next.currency)} expense${next.vendor ? ` at ${next.vendor}` : ''}`;
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'updated', entityType: 'expense', entityId: row.id, summary: `${req.user.name} ${verb}`, meta: { changed: Object.keys(body) } });
  res.json({ ...expenseRow(one('SELECT * FROM expenses WHERE id = ?', row.id)), receipts: receiptsFor([row.id]).get(row.id) || [] });
});

router.delete('/expenses/:id', (req, res) => {
  const row = one('SELECT * FROM expenses WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!row) throw notFound('Expense');
  const current = expenseRow(row);
  if (!canEdit(req, current)) throw forbidden('Only the person who added this expense or an admin can delete it');
  const files = all('SELECT stored_name FROM receipts WHERE expense_id = ?', row.id);
  tx(() => { db.prepare('DELETE FROM expenses WHERE id = ?').run(row.id); });
  for (const f of files) fs.rm(path.join(config.dataDir, 'uploads', f.stored_name), { force: true }, () => {});
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'deleted', entityType: 'expense', entityId: row.id, summary: `${req.user.name} deleted a ${fmtMoney(current.amountCents, current.currency)} expense${current.vendor ? ` at ${current.vendor}` : ''}` });
  res.json({ ok: true });
});

// ---------- receipts (encrypted on disk) ----------
const rawBody = express.raw({ type: () => true, limit: config.maxReceiptBytes });

router.post('/expenses/:id/receipts', rawBody, (req, res) => {
  const row = one('SELECT * FROM expenses WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!row) throw notFound('Expense');
  if (!canEdit(req, expenseRow(row))) throw forbidden();
  const mime = String(req.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!RECEIPT_TYPES.has(mime)) throw new HttpError(415, 'Receipts must be an image or PDF');
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Empty upload');
  const count = one('SELECT count(*) AS c FROM receipts WHERE expense_id = ?', row.id).c;
  if (count >= 10) throw new HttpError(409, 'At most 10 receipts per expense');
  let filename = decodeURIComponent(String(req.get('X-Filename') || 'receipt')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || 'receipt';
  const storedName = `${randomToken(24)}.bin`;
  fs.writeFileSync(path.join(config.dataDir, 'uploads', storedName), encryptBuffer(req.body), { mode: 0o600 });
  const id = uid();
  db.prepare('INSERT INTO receipts (id, company_id, expense_id, filename_enc, mime, size, stored_name, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.company.id, row.id, encrypt(filename), mime, req.body.length, storedName, req.user.id, now());
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'attached', entityType: 'expense', entityId: row.id, summary: `${req.user.name} attached the receipt "${filename}"` });
  res.status(201).json(receiptRow(one('SELECT * FROM receipts WHERE id = ?', id)));
});

router.get('/receipts/:id', (req, res) => {
  const r = one('SELECT * FROM receipts WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!r) throw notFound('Receipt');
  const file = path.join(config.dataDir, 'uploads', r.stored_name);
  if (!fs.existsSync(file)) throw notFound('Receipt file');
  const bytes = decryptBuffer(fs.readFileSync(file));
  const filename = receiptRow(r).filename;
  res.setHeader('Content-Type', r.mime);
  res.setHeader('Content-Length', bytes.length);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(bytes);
});

router.delete('/receipts/:id', (req, res) => {
  const r = one('SELECT * FROM receipts WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!r) throw notFound('Receipt');
  const exp = one('SELECT * FROM expenses WHERE id = ?', r.expense_id);
  if (exp && !canEdit(req, expenseRow(exp))) throw forbidden();
  db.prepare('DELETE FROM receipts WHERE id = ?').run(r.id);
  fs.rm(path.join(config.dataDir, 'uploads', r.stored_name), { force: true }, () => {});
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'deleted', entityType: 'expense', entityId: r.expense_id, summary: `${req.user.name} removed the receipt "${receiptRow(r).filename}"` });
  res.json({ ok: true });
});

export default router;
