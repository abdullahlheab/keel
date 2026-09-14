import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client } from './helpers.js';

let srv; let owner; let member;
let projectId; let taskIds = []; let memberTaskId; let expenseIds = []; let memberExpenseId;

before(async () => {
  srv = await bootServer({ ALLOW_OPEN_SIGNUP: 'true' });
  owner = client(srv.base);
  member = client(srv.base);
  await owner.post('/api/auth/register', { name: 'Owner', email: 'owner@x.com', password: 'first-long-password', companyName: 'Bulk Co' });
  const inv = await owner.post('/api/company/invites', { role: 'member' });
  await member.post(`/api/auth/invites/${inv.data.url.split('/invite/')[1]}/accept`, { name: 'Mem', email: 'mem@x.com', password: 'second-long-password' });
  projectId = (await owner.post('/api/projects', { name: 'Bulk project' })).data.id;
  for (const title of ['One', 'Two', 'Three']) taskIds.push((await owner.post('/api/tasks', { title, status: 'todo', labels: ['old'] })).data.id);
  memberTaskId = (await member.post('/api/tasks', { title: 'Mine', status: 'todo' })).data.id;
  for (const amount of [10, 20, 30]) expenseIds.push((await owner.post('/api/expenses', { amount, date: '2026-09-01', vendor: 'V' })).data.id);
  memberExpenseId = (await member.post('/api/expenses', { amount: 5, date: '2026-09-02', vendor: 'M' })).data.id;
});
after(async () => { await srv.close(); });

test('bulk update sets the same field on every selected task', async () => {
  const r = await owner.post('/api/tasks/bulk', { ids: taskIds.slice(0, 2), action: 'update', data: { priority: 'high', projectId } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.items.map((t) => t.priority), ['high', 'high']);
  assert.deepEqual(r.data.items.map((t) => t.projectId), [projectId, projectId]);
  const cleared = await owner.post('/api/tasks/bulk', { ids: [taskIds[0]], action: 'update', data: { projectId: null, dueDate: null } });
  assert.equal(cleared.data.items[0].projectId, null);
  const nothing = await owner.post('/api/tasks/bulk', { ids: taskIds, action: 'update', data: {} });
  assert.equal(nothing.status, 400);
});

test('bulk move places the selection at an index in the target column', async () => {
  const r = await owner.post('/api/tasks/bulk', { ids: [taskIds[2], taskIds[1]], action: 'move', data: { status: 'done', index: 0 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.items.every((t) => t.status === 'done' && t.completedAt));
  const done = (await owner.get('/api/tasks?status=done')).data.items;
  assert.deepEqual(done.map((t) => t.id), [taskIds[2], taskIds[1]], 'selection order is preserved');
});

test('labels can be added to and removed from a selection', async () => {
  const add = await owner.post('/api/tasks/bulk', { ids: taskIds, action: 'add_label', data: { label: 'sprint-1' } });
  assert.ok(add.data.items.every((t) => t.labels.includes('sprint-1') && t.labels.includes('old')));
  const rm = await owner.post('/api/tasks/bulk', { ids: taskIds, action: 'remove_label', data: { label: 'old' } });
  assert.ok(rm.data.items.every((t) => !t.labels.includes('old')));
});

test('duplicate creates copies with new numbers', async () => {
  const r = await owner.post('/api/tasks/bulk', { ids: [taskIds[0]], action: 'duplicate' });
  assert.equal(r.status, 201);
  assert.equal(r.data.items[0].title, 'One (copy)');
  assert.notEqual(r.data.items[0].id, taskIds[0]);
  assert.ok(r.data.items[0].number > 4);
  await owner.post('/api/tasks/bulk', { ids: [r.data.items[0].id], action: 'delete' });
});

test('members cannot bulk-delete tasks they did not create, owners can', async () => {
  const denied = await member.post('/api/tasks/bulk', { ids: [taskIds[0], memberTaskId], action: 'delete' });
  assert.equal(denied.status, 403);
  const ok = await member.post('/api/tasks/bulk', { ids: [memberTaskId], action: 'delete' });
  assert.equal(ok.data.deleted, 1);
  const missing = await owner.post('/api/tasks/bulk', { ids: [memberTaskId], action: 'delete' });
  assert.equal(missing.status, 404);
  const del = await owner.post('/api/tasks/bulk', { ids: taskIds.slice(1), action: 'delete' });
  assert.equal(del.data.deleted, 2);
  assert.equal((await owner.get(`/api/tasks/${taskIds[1]}`)).status, 404);
});

test('bulk expense update, export of a selection, and permissions', async () => {
  const denied = await member.post('/api/expenses/bulk', { ids: [expenseIds[0], memberExpenseId], action: 'update', data: { status: 'reimbursed' } });
  assert.equal(denied.status, 403);
  const r = await owner.post('/api/expenses/bulk', { ids: expenseIds, action: 'update', data: { status: 'reimbursed', projectId } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.items.every((e) => e.status === 'reimbursed' && e.projectId === projectId));
  const csv = await owner.get(`/api/expenses/export.csv?ids=${expenseIds.slice(0, 2).join(',')}`);
  const lines = csv.data.trim().split(/\r?\n/);
  assert.equal(lines.length, 3, 'header + two selected rows');
  const list = await owner.get(`/api/expenses?ids=${expenseIds[2]}`);
  assert.equal(list.data.total, 1);
  const del = await owner.post('/api/expenses/bulk', { ids: expenseIds.slice(0, 2), action: 'delete' });
  assert.equal(del.data.deleted, 2);
  assert.equal((await owner.get('/api/expenses')).data.total, 2);
});

test('bulk actions are recorded in the activity log', async () => {
  const items = (await owner.get('/api/activity?limit=100')).data.items.map((a) => a.summary);
  assert.ok(items.some((s) => /moved 2 tasks to Done/.test(s)), 'task move logged');
  assert.ok(items.some((s) => /marked 3 expenses/.test(s)), 'expense update logged');
  assert.ok(items.some((s) => /deleted 2 tasks/.test(s)), 'task delete logged');
});
