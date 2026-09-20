// One continuous story: an empty database becomes a working company. Each test picks up where the
// last left off, in the order two founders would actually do this, touching every feature once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootServer, client } from './helpers.js';

let srv; let ada; let bo; let carol;
const ids = { project: null, task: null, topic: null, expense: null, receipt: null, category: null, boUser: null, key: null };

function apiClient(key) {
  const c = client(srv.base);
  const opts = { headers: { Authorization: `Bearer ${key}` }, noCsrf: true };
  return { get: (u) => c.get(u, opts), post: (u, b) => c.post(u, b, opts), patch: (u, b) => c.patch(u, b, opts), del: (u) => c.del(u, opts) };
}

before(async () => {
  srv = await bootServer();
  ada = client(srv.base); bo = client(srv.base); carol = client(srv.base);
});
after(async () => { await srv.close(); });

test('1. the first visitor becomes the owner and the company exists', async () => {
  const policy = await ada.get('/api/auth/policy');
  assert.equal(policy.data.firstRun, true, 'an empty install is in first-run mode');

  const reg = await ada.post('/api/auth/register', { name: 'Ada Rivers', email: 'ada@example.test', password: 'first-long-password', companyName: 'Northwind', currency: 'EUR' });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  assert.equal(reg.data.companies[0].role, 'owner');
  assert.equal(reg.data.companies[0].currency, 'EUR');
  assert.equal(reg.data.companies[0].key, 'NORT', 'a reference key is derived from the name');
  assert.ok(!JSON.stringify(reg.data).includes('first-long-password'), 'the password never comes back');

  assert.equal((await ada.get('/api/auth/policy')).data.firstRun, false, 'first run is over');

  const company = await ada.get('/api/company');
  assert.equal(company.data.members.length, 1);
  assert.ok(company.data.categories.length > 0, 'expense categories are seeded');
  ids.category = company.data.categories[0].id;
});

test('2. the co-founder is invited and joins as an admin', async () => {
  const inv = await ada.post('/api/company/invites', { email: 'bo@example.test', role: 'admin' });
  assert.equal(inv.status, 201);
  assert.match(inv.data.url, /\/invite\/[A-Za-z0-9_-]{20,}$/);
  const token = inv.data.url.split('/invite/')[1];

  const preview = await bo.get(`/api/auth/invites/${token}`);
  assert.equal(preview.data.state, 'valid');
  assert.equal(preview.data.companyName, 'Northwind');
  assert.equal(preview.data.inviterName, 'Ada Rivers');

  const joined = await bo.post(`/api/auth/invites/${token}/accept`, { name: 'Bo Sandoval', email: 'bo@example.test', password: 'second-long-password' });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  assert.equal(joined.data.companies[0].role, 'admin');
  ids.boUser = joined.data.user.id;

  const reused = await carol.post(`/api/auth/invites/${token}/accept`, { name: 'C', email: 'c@example.test', password: 'third-long-password' });
  assert.equal(reused.status, 410, 'an invite is single use');

  assert.equal((await ada.get('/api/company')).data.members.length, 2);
});

test('3. a project is created and shows up with empty stats', async () => {
  const p = await ada.post('/api/projects', { name: 'Beta launch', description: 'Ship to the first 50 customers', status: 'active', color: '#2a78d6', budget: '25,000.00', startDate: '2026-09-01', endDate: '2026-12-31', leadUserId: ids.boUser });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  ids.project = p.data.id;
  assert.equal(p.data.budgetCents, 2500000, 'a formatted amount parses to cents');
  assert.equal(p.data.leadUserId, ids.boUser);

  const list = await ada.get('/api/projects');
  const found = list.data.items.find((x) => x.id === ids.project);
  assert.equal(found.spentCents, 0);
  assert.equal(found.taskTotal, 0);
});

test('4. work lands on the board and moves across it', async () => {
  const t = await bo.post(`/api/projects/${ids.project}/tasks`, { title: 'Write the launch email', priority: 'high', dueDate: '2026-10-15', labels: ['marketing'], assigneeUserId: ids.boUser });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  ids.task = t.data.id;
  assert.equal(t.data.ref, 'NORT-1', 'the first task is number 1');
  assert.equal(t.data.projectId, ids.project);
  assert.equal(t.data.status, 'todo');

  await ada.post('/api/tasks', { title: 'Set up the analytics dashboard', projectId: ids.project });
  await ada.post('/api/tasks', { title: 'Unrelated errand' });

  const moved = await bo.post(`/api/tasks/${ids.task}/move`, { status: 'in_progress', index: 0 });
  assert.equal(moved.data.status, 'in_progress');
  assert.equal(moved.data.completedAt, null);

  const done = await bo.patch(`/api/tasks/NORT-1`, { status: 'done' });
  assert.ok(done.data.completedAt, 'finishing a task stamps completedAt');

  const checklist = await bo.patch(`/api/tasks/${ids.task}`, { checklist: [{ text: 'Draft', done: true }, { text: 'Proofread', done: false }] });
  assert.equal(checklist.data.checklist.length, 2);
  assert.ok(checklist.data.checklist[0].id, 'checklist items get ids');

  const comment = await ada.post(`/api/tasks/${ids.task}/comments`, { body: 'Looks good, shipping it.' });
  assert.equal(comment.status, 201);
  const withComments = await ada.get(`/api/tasks/${ids.task}`);
  assert.equal(withComments.data.comments.length, 1);
  assert.equal(withComments.data.commentCount, 1);

  const stats = (await ada.get('/api/projects')).data.items.find((x) => x.id === ids.project);
  assert.equal(stats.taskTotal, 2);
  assert.equal(stats.taskDone, 1);
  assert.equal(stats.taskOpen, 1);
});

test('5. money is spent, receipted and summarised', async () => {
  const e = await bo.post('/api/expenses', { amount: '1,299.99', date: '2026-09-15', vendor: 'Mailchimp', description: 'Annual plan', categoryId: ids.category, projectId: ids.project, paymentMethod: 'card', status: 'paid', paidByUserId: ids.boUser });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  ids.expense = e.data.id;
  assert.equal(e.data.amountCents, 129999);
  assert.equal(e.data.currency, 'EUR', 'the company currency is the default');

  await ada.post('/api/expenses', { amount: 40, date: '2026-08-02', vendor: 'Hosting', projectId: ids.project, recurring: 'monthly' });
  await ada.post('/api/expenses', { amount: 12.5, date: '2026-09-20', vendor: 'Coffee', status: 'pending' });

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const up = await bo.post(`/api/expenses/${ids.expense}/receipts`, png, { headers: { 'Content-Type': 'image/png', 'X-Filename': 'invoice%20sept.png' } });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  ids.receipt = up.data.id;
  assert.equal(up.data.filename, 'invoice sept.png');

  const raw = fs.readdirSync(path.join(srv.dataDir, 'uploads')).map((f) => fs.readFileSync(path.join(srv.dataDir, 'uploads', f)));
  assert.ok(raw.every((buf) => !buf.includes(png)), 'the receipt is encrypted on disk');
  const back = await bo.get(`/api/receipts/${ids.receipt}`, { raw: true });
  assert.ok(back.data.equals(png), 'and decrypts back to the original bytes');

  const summary = await ada.get('/api/expenses/summary');
  assert.equal(summary.data.currency, 'EUR');
  assert.equal(summary.data.totals.allTimeCents, 129999 + 4000 + 1250);
  assert.equal(summary.data.totals.count, 3);
  assert.equal(summary.data.totals.pendingCents, 1250);
  assert.equal(summary.data.totals.pendingCount, 1);
  assert.equal(summary.data.totals.recurringMonthlyCents, 4000, 'the monthly subscription is counted once');
  assert.equal(summary.data.byMonth.length, 12);

  const byProject = summary.data.byProject.find((p) => p.projectId === ids.project);
  assert.equal(byProject.cents, 129999 + 4000);
  assert.equal(byProject.name, 'Beta launch');
  assert.ok(summary.data.byProject.some((p) => p.projectId === null && p.name === 'No project'));

  const budget = summary.data.budgets.find((b) => b.projectId === ids.project);
  assert.equal(budget.budgetCents, 2500000);
  assert.equal(budget.spentCents, 133999, 'budget meters compare against real spend');

  const ranged = await ada.get('/api/expenses/summary?from=2026-09-01&to=2026-09-30');
  assert.equal(ranged.data.totals.rangeCents, 129999 + 1250, 'the August expense falls outside the range');
  assert.equal(ranged.data.totals.allTimeCents, 129999 + 4000 + 1250, 'all-time ignores the range');

  const project = (await ada.get('/api/projects')).data.items.find((x) => x.id === ids.project);
  assert.equal(project.spentCents, 133999);
  assert.equal(project.expenseCount, 2);

  const csv = await ada.get('/api/expenses/export.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.data.includes('Mailchimp'), 'the export carries the decrypted values');
});

test('6. the team talks it through in the discussion room', async () => {
  const topic = await bo.post('/api/discussions', { title: 'Do we delay the launch a week?', body: 'The email is not ready.', category: 'question', projectId: ids.project });
  assert.equal(topic.status, 201, JSON.stringify(topic.data));
  ids.topic = topic.data.id;
  assert.equal(topic.data.ref, 'NORT-D1');

  const reply = await ada.post(`/api/discussions/NORT-D1/posts`, { body: 'No - ship it Friday as planned.' });
  assert.equal(reply.status, 201);
  const nested = await bo.post(`/api/discussions/${ids.topic}/posts`, { body: 'Agreed.', parentId: reply.data.id });
  assert.equal(nested.data.parentId, reply.data.id);

  const marked = await bo.patch(`/api/discussions/${ids.topic}/posts/${reply.data.id}`, { answer: true });
  assert.equal(marked.data.isAnswer, true);
  const resolved = await ada.get(`/api/discussions/${ids.topic}`);
  assert.equal(resolved.data.state, 'resolved');
  assert.equal(resolved.data.posts.length, 2);

  const pinned = await ada.patch(`/api/discussions/${ids.topic}`, { pinned: true });
  assert.equal(pinned.data.pinned, true);

  const scoped = await ada.get(`/api/projects/${ids.project}/discussions`);
  assert.equal(scoped.data.items.length, 1);
});

test('7. everything that happened is in the activity log, attributed', async () => {
  const feed = await ada.get('/api/activity?limit=200');
  const summaries = feed.data.items.map((a) => a.summary);
  const types = new Set(feed.data.items.map((a) => a.entityType));
  for (const kind of ['company', 'member', 'project', 'task', 'expense', 'discussion']) {
    assert.ok(types.has(kind), `the feed covers ${kind}`);
  }
  assert.ok(summaries.some((s) => s.startsWith('Bo Sandoval')), 'entries name who acted');
  assert.ok(summaries.some((s) => s.includes('NORT-1')), 'tasks are named by reference');
  assert.ok(summaries.some((s) => s.includes('NORT-D1')), 'so are topics');

  const filtered = await ada.get('/api/activity?entityType=task');
  assert.ok(filtered.data.items.every((a) => a.entityType === 'task'));
  const mine = await ada.get(`/api/activity?userId=${ids.boUser}`);
  assert.ok(mine.data.items.every((a) => a.userId === ids.boUser));
});

test('8. the dashboard numbers agree with the underlying data', async () => {
  const company = await ada.get('/api/company');
  assert.equal(company.data.counts.projects, 1);
  assert.equal(company.data.counts.expenses, 3);
  assert.equal(company.data.counts.openTasks, 2, 'one of the three tasks is done');
});

test('9. a key is issued and a script drives the same workspace', async () => {
  const created = await ada.post('/api/keys', { name: 'Release bot', scope: 'write', password: 'first-long-password' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  ids.key = created.data.secret;
  const bot = apiClient(ids.key);

  const me = await bot.get('/api/v1/me');
  assert.equal(me.data.actingAs.name, 'Ada Rivers');
  assert.equal(me.data.company.key, 'NORT');
  assert.equal(me.data.key.scope, 'write');

  const task = await bot.post('/api/v1/tasks', { title: 'Cut the release', priority: 'urgent' });
  assert.equal(task.status, 201);
  assert.equal(task.data.ref, 'NORT-4', 'numbering continues across the app and the API');

  const topic = await bot.post('/api/v1/discussions', { title: 'Release notes for 1.0', category: 'announcement' });
  assert.equal(topic.data.ref, 'NORT-D2');
  await bot.post(`/api/v1/discussions/${topic.data.ref}/posts`, { body: 'Draft is in the shared drive.' });

  const expense = await bot.post('/api/v1/expenses', { amount: 9.99, date: '2026-09-21', vendor: 'Domain renewal' });
  assert.equal(expense.status, 201);

  const feed = await ada.get('/api/activity?limit=50');
  assert.ok(feed.data.items.some((a) => a.summary.includes('(API: Release bot)')), 'API changes are labelled with the key');

  // The same read through both doors gives the same answer.
  const viaApi = (await bot.get('/api/v1/tasks')).data.items.map((t) => t.ref).sort();
  const viaApp = (await ada.get('/api/tasks')).data.items.map((t) => t.ref).sort();
  assert.deepEqual(viaApi, viaApp);
});

test('10. nothing sensitive is readable in the database file', async () => {
  const file = fs.readFileSync(path.join(srv.dataDir, 'tracker.sqlite'));
  const wal = path.join(srv.dataDir, 'tracker.sqlite-wal');
  const blob = Buffer.concat([file, fs.existsSync(wal) ? fs.readFileSync(wal) : Buffer.alloc(0)]).toString('latin1');

  const secrets = [
    'Write the launch email', 'Set up the analytics dashboard', 'Cut the release',
    'Beta launch', 'Ship to the first 50 customers',
    'Mailchimp', 'Annual plan', 'invoice sept.png',
    'Do we delay the launch a week?', 'The email is not ready.', 'No - ship it Friday as planned.',
    'Looks good, shipping it.', 'Release notes for 1.0',
  ];
  for (const s of secrets) assert.ok(!blob.includes(s), `"${s}" must not be readable in the database file`);

  assert.ok(!blob.includes('first-long-password'), 'passwords are hashed');
  assert.ok(!blob.includes(ids.key), 'API keys are stored as hashes');

  // Structural columns stay queryable on purpose, so the file does contain them.
  assert.ok(blob.includes('in_progress') || blob.includes('done'), 'enums are deliberately not encrypted');
});

test('11. a founder can hand over and leave', async () => {
  const promote = await ada.patch(`/api/company/members/${ids.boUser}`, { role: 'owner' });
  assert.equal(promote.status, 200, JSON.stringify(promote.data));
  assert.equal(promote.data.items.find((m) => m.id === ids.boUser).role, 'owner');

  const me = (await ada.get('/api/auth/me')).data;
  const adaId = me.user.id;
  const leave = await ada.del(`/api/company/members/${adaId}`);
  assert.equal(leave.status, 200);
  assert.equal(leave.data.left, true);

  const afterLeaving = await ada.get('/api/company');
  assert.equal(afterLeaving.status, 409, 'she is no longer in a company');

  const orphaned = apiClient(ids.key);
  assert.equal((await orphaned.get('/api/v1/tasks')).status, 401, 'and her API key stops working');

  const still = await bo.get('/api/company');
  assert.equal(still.data.members.length, 1);
  assert.equal(still.data.role, 'owner', 'Bo now owns the company and the data is intact');
  assert.equal((await bo.get('/api/tasks')).data.items.length, 4);
  assert.equal((await bo.get('/api/discussions')).data.items.length, 2);
});
