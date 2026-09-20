// Does the data stay correct under deletion, odd input, limits and parallel writes?
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootServer, client } from './helpers.js';

let srv; let owner; let mate; let mateId; let companyKey;

before(async () => {
  srv = await bootServer();
  owner = client(srv.base);
  await owner.post('/api/auth/register', { name: 'Ida', email: 'ida@x.test', password: 'first-long-password', companyName: 'Integrity Co' });
  const inv = await owner.post('/api/company/invites', { role: 'member' });
  mate = client(srv.base);
  mateId = (await mate.post(`/api/auth/invites/${inv.data.url.split('/invite/')[1]}/accept`, { name: 'Milo', email: 'milo@x.test', password: 'second-long-password' })).data.user.id;
  companyKey = (await owner.get('/api/company')).data.company.key;
});
after(async () => { await srv.close(); });

test('deleting a project keeps the work and the spend, just unfiled', async () => {
  const project = (await owner.post('/api/projects', { name: 'Doomed', budget: 1000 })).data.id;
  const task = (await owner.post('/api/tasks', { title: 'Survivor task', projectId: project })).data.id;
  const expense = (await owner.post('/api/expenses', { amount: 250, date: '2026-09-04', vendor: 'Survivor spend', projectId: project })).data.id;
  const topic = (await owner.post('/api/discussions', { title: 'Survivor topic', projectId: project })).data.id;

  assert.equal((await owner.del(`/api/projects/${project}`)).status, 200);

  const t = await owner.get(`/api/tasks/${task}`);
  assert.equal(t.status, 200, 'the task outlives its project');
  assert.equal(t.data.projectId, null);
  assert.equal((await owner.get(`/api/expenses/${expense}`)).data.projectId, null, 'so does the expense');
  assert.equal((await owner.get(`/api/discussions/${topic}`)).data.projectId, null, 'and the topic');

  const summary = await owner.get('/api/expenses/summary');
  assert.equal(summary.data.totals.allTimeCents, 25000, 'the money is still counted');
  assert.ok(!summary.data.budgets.some((b) => b.projectId === project), 'the budget meter is gone with the project');

  await owner.del(`/api/tasks/${task}`);
  await owner.del(`/api/expenses/${expense}`);
  await owner.del(`/api/discussions/${topic}`);
});

test('deleting a topic takes its replies; deleting a task takes its comments', async () => {
  const topic = (await owner.post('/api/discussions', { title: 'Short lived' })).data.id;
  const post = (await owner.post(`/api/discussions/${topic}/posts`, { body: 'first' })).data.id;
  await owner.post(`/api/discussions/${topic}/posts`, { body: 'second', parentId: post });
  assert.equal((await owner.get(`/api/discussions/${topic}`)).data.posts.length, 2);
  await owner.del(`/api/discussions/${topic}`);
  assert.equal((await owner.get(`/api/discussions/${topic}`)).status, 404);
  assert.equal((await owner.get(`/api/discussions/${topic}/posts`)).status, 404, 'the replies went with it');

  const task = (await owner.post('/api/tasks', { title: 'Short lived task' })).data.id;
  await owner.post(`/api/tasks/${task}/comments`, { body: 'a note' });
  await owner.del(`/api/tasks/${task}`);
  assert.equal((await owner.get(`/api/tasks/${task}`)).status, 404);
});

test('deleting a category leaves the expenses, just uncategorised', async () => {
  const cat = (await owner.post('/api/company/categories', { name: 'Temporary', color: '#123456' })).data.id;
  const expense = (await owner.post('/api/expenses', { amount: 5, date: '2026-09-05', vendor: 'Thing', categoryId: cat })).data.id;
  const del = await owner.del(`/api/company/categories/${cat}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.detachedExpenses, 1, 'the response says how many were affected');
  assert.equal((await owner.get(`/api/expenses/${expense}`)).data.categoryId, null);
  await owner.del(`/api/expenses/${expense}`);
});

test('removing a member leaves their work behind, attributed to nobody', async () => {
  const task = (await owner.post('/api/tasks', { title: 'Assigned work', assigneeUserId: mateId })).data.id;
  const expense = (await mate.post('/api/expenses', { amount: 15, date: '2026-09-06', vendor: 'Milo spend' })).data.id;
  const topic = (await mate.post('/api/discussions', { title: 'Milo topic' })).data.id;

  assert.equal((await owner.del(`/api/company/members/${mateId}`)).status, 200);

  const t = await owner.get(`/api/tasks/${task}`);
  assert.equal(t.status, 200, 'the task survives');
  assert.equal((await owner.get(`/api/expenses/${expense}`)).status, 200, 'so does the expense');
  assert.equal((await owner.get(`/api/discussions/${topic}`)).data.title, 'Milo topic', 'and the topic');

  // The membership is gone, so the person is no longer listed even though rows still point at them.
  assert.ok(!(await owner.get('/api/company')).data.members.some((m) => m.id === mateId));
  const summary = await owner.get('/api/expenses/summary');
  assert.ok(summary.data.byPayer.every((p) => p.userId !== mateId || p.name === 'Former member'), 'the summary copes with a payer who left');
});

test('money survives the round trip exactly, including awkward values', async () => {
  const cases = [
    ['0.01', 1], ['0.1', 10], [0.07, 7], ['1,234.56', 123456], ['$99', 9900],
    [1000000, 100000000], ['-45.50', -4550], [12.005, 1201], ['  88.80  ', 8880],
  ];
  const made = [];
  for (const [input, cents] of cases) {
    const res = await owner.post('/api/expenses', { amount: input, date: '2026-01-15', vendor: `Case ${input}` });
    assert.equal(res.status, 201, `${input}: ${JSON.stringify(res.data)}`);
    assert.equal(res.data.amountCents, cents, `${JSON.stringify(input)} should be ${cents} cents`);
    made.push(res.data.id);
  }
  const total = cases.reduce((s, [, c]) => s + c, 0);
  const listed = await owner.get('/api/expenses?from=2026-01-01&to=2026-01-31');
  assert.equal(listed.data.sumCents, total, 'the list total is exact, with no floating point drift');

  for (const bad of ['abc', '', '1.234', 'NaN', '1e5', null, {}, []]) {
    const res = await owner.post('/api/expenses', { amount: bad, date: '2026-01-15' });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} must be rejected`);
  }
  for (const id of made) await owner.del(`/api/expenses/${id}`);
});

test('validation drops what it does not know and clears what you null out', async () => {
  const created = await owner.post('/api/tasks', { title: 'Tidy', priority: 'low', bogusField: 'ignored', id: 'not-mine', createdBy: 'not-mine' });
  assert.equal(created.status, 201);
  assert.notEqual(created.data.id, 'not-mine', 'a client cannot choose its own id');
  assert.equal(created.data.bogusField, undefined, 'unknown keys are dropped, not stored');

  const withValues = await owner.patch(`/api/tasks/${created.data.id}`, { dueDate: '2026-12-01', assigneeUserId: null, description: 'text' });
  assert.equal(withValues.data.dueDate, '2026-12-01');
  const cleared = await owner.patch(`/api/tasks/${created.data.id}`, { dueDate: null, description: null });
  assert.equal(cleared.data.dueDate, null, 'null clears a field');
  assert.equal(cleared.data.description, null);

  for (const bad of [{ status: 'nonsense' }, { priority: 'critical' }, { dueDate: '01-01-2026' }, { projectId: 'not-a-uuid' }, { title: '' }]) {
    const res = await owner.patch(`/api/tasks/${created.data.id}`, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.ok(res.data.fields, 'validation errors name the field');
  }
  assert.equal((await owner.post('/api/tasks', { title: 'x'.repeat(201) })).status, 400, 'over-long titles are refused');
  assert.equal((await owner.post('/api/discussions', { title: 'ok', body: 'x'.repeat(20001) })).status, 400, 'so are over-long bodies');
  assert.equal((await owner.post('/api/tasks', ['not', 'an', 'object'])).status, 400);
  await owner.del(`/api/tasks/${created.data.id}`);
});

test('text with quotes, newlines and unicode round-trips through encryption intact', async () => {
  const nasty = 'Ünïcødé "quotes", \'apostrophes\', \nnewlines, <tags>, emoji 🚀, and a trailing backslash \\';
  const topic = await owner.post('/api/discussions', { title: 'Encoding check', body: nasty });
  assert.equal(topic.data.body, nasty);
  const reply = await owner.post(`/api/discussions/${topic.data.id}/posts`, { body: nasty });
  assert.equal(reply.data.body, nasty);
  const reread = await owner.get(`/api/discussions/${topic.data.id}`);
  assert.equal(reread.data.body, nasty);
  assert.equal(reread.data.posts[0].body, nasty);

  const blob = fs.readFileSync(path.join(srv.dataDir, 'tracker.sqlite')).toString('latin1');
  assert.ok(!blob.includes('Ünïcødé'), 'and is not readable on disk');
  await owner.del(`/api/discussions/${topic.data.id}`);
});

test('reference numbers stay unique when writes arrive together', async () => {
  const before = (await owner.get('/api/tasks')).data.items.length;
  const tasks = await Promise.all(Array.from({ length: 25 }, (_, i) => owner.post('/api/tasks', { title: `Parallel ${i}` })));
  assert.ok(tasks.every((t) => t.status === 201), 'every parallel create succeeded');
  const refs = tasks.map((t) => t.data.ref);
  assert.equal(new Set(refs).size, 25, 'no two tasks share a reference');
  assert.equal((await owner.get('/api/tasks')).data.items.length, before + 25);

  const topics = await Promise.all(Array.from({ length: 15 }, (_, i) => owner.post('/api/discussions', { title: `Parallel topic ${i}` })));
  assert.equal(new Set(topics.map((t) => t.data.ref)).size, 15, 'topic numbering holds up too');
  assert.ok(topics.every((t) => new RegExp(`^${companyKey}-D\\d+$`).test(t.data.ref)), `refs should look like ${companyKey}-D1`);

  await owner.post('/api/tasks/bulk', { ids: tasks.map((t) => t.data.id), action: 'delete' });
  await owner.post('/api/discussions/bulk', { ids: topics.map((t) => t.data.id), action: 'delete' });
});

test('parallel replies to one topic all land and the count agrees', async () => {
  const topic = (await owner.post('/api/discussions', { title: 'Busy thread' })).data.id;
  const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => owner.post(`/api/discussions/${topic}/posts`, { body: `reply ${i}` })));
  assert.ok(replies.every((r) => r.status === 201));
  const fresh = await owner.get(`/api/discussions/${topic}`);
  assert.equal(fresh.data.posts.length, 20);
  assert.equal(fresh.data.replyCount, 20, 'the denormalised count matches the rows');
  assert.equal(new Set(fresh.data.posts.map((p) => p.id)).size, 20);
  await owner.del(`/api/discussions/${topic}`);
});

test('receipts enforce their type, count and ownership rules', async () => {
  const expense = (await owner.post('/api/expenses', { amount: 30, date: '2026-09-07', vendor: 'Receipts' })).data.id;

  const bad = await owner.post(`/api/expenses/${expense}/receipts`, Buffer.from('hello'), { headers: { 'Content-Type': 'text/plain', 'X-Filename': 'note.txt' } });
  assert.equal(bad.status, 415, 'only images and PDFs');

  const empty = await owner.post(`/api/expenses/${expense}/receipts`, Buffer.alloc(0), { headers: { 'Content-Type': 'image/png', 'X-Filename': 'empty.png' } });
  assert.equal(empty.status, 400, 'an empty upload is refused');

  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  for (let i = 0; i < 10; i++) {
    const res = await owner.post(`/api/expenses/${expense}/receipts`, png, { headers: { 'Content-Type': 'image/png', 'X-Filename': `r${i}.png` } });
    assert.equal(res.status, 201, `upload ${i}: ${JSON.stringify(res.data)}`);
  }
  const eleventh = await owner.post(`/api/expenses/${expense}/receipts`, png, { headers: { 'Content-Type': 'image/png', 'X-Filename': 'r10.png' } });
  assert.equal(eleventh.status, 409, 'ten per expense is the cap');

  // A dangerous filename is defused rather than trusted.
  const nasty = await owner.post(`/api/expenses/${(await owner.post('/api/expenses', { amount: 1, date: '2026-09-08' })).data.id}/receipts`, png,
    { headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('../../etc/passwd.png') } });
  assert.equal(nasty.status, 201);
  assert.ok(!nasty.data.filename.includes('/'), `path separators are stripped, got ${nasty.data.filename}`);

  const withReceipts = await owner.get(`/api/expenses/${expense}`);
  assert.equal(withReceipts.data.receipts.length, 10);
});

test('paging and filtering agree with each other across every list', async () => {
  const lists = ['/api/tasks', '/api/expenses', '/api/discussions'];
  for (const base of lists) {
    const all = await owner.get(base);
    const total = all.data.total ?? all.data.items.length;
    if (total < 3) continue;
    const firstTwo = await owner.get(`${base}?limit=2`);
    assert.equal(firstTwo.data.items.length, 2, `${base} honours limit`);
    assert.equal(firstTwo.data.total, total, `${base} reports the unpaged total`);
    const skipped = await owner.get(`${base}?limit=2&offset=1`);
    assert.equal(skipped.data.items[0].id, firstTwo.data.items[1].id, `${base} offset lines up with limit`);
    const past = await owner.get(`${base}?offset=100000`);
    assert.equal(past.data.items.length, 0, `${base} past the end is empty, not an error`);
  }

  const since = new Date(Date.now() + 60_000).toISOString();
  assert.equal((await owner.get(`/api/tasks?updatedSince=${since}`)).data.items.length, 0, 'a future cursor returns nothing');
  const long = await owner.get(`/api/discussions?q=${'x'.repeat(500)}`);
  assert.equal(long.status, 200, 'a silly search term is handled, not fatal');
  assert.equal(long.data.items.length, 0);
});

test('errors come back in one predictable shape', async () => {
  const notFound = await owner.get('/api/tasks/00000000-0000-4000-8000-000000000000');
  assert.equal(notFound.status, 404);
  assert.equal(typeof notFound.data.error, 'string');
  assert.ok(!('stack' in notFound.data), 'no internals leak');

  const badJson = await owner.post('/api/tasks', undefined, { headers: { 'Content-Type': 'application/json' }, rawBody: '{oops' });
  assert.ok([400, 500].includes(badJson.status));

  const unknown = await owner.get('/api/not-a-real-endpoint');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error, 'Not found');

  const noAuth = client(srv.base);
  const guarded = await noAuth.get('/api/tasks');
  assert.equal(guarded.status, 401);
  assert.match(guarded.data.error, /sign in/i);
});
