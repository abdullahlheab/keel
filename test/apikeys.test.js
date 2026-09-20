import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client } from './helpers.js';

let srv; let owner; let member; let db;
let projectId; let writeKey; let readKey; let memberKey; let writeKeyId; let memberUserId; let ownerTaskId;

// A client that sends only an API key: no cookies, no CSRF header.
function apiClient(key, headerName = 'Authorization') {
  const c = client(srv.base);
  const headers = key ? { [headerName]: headerName === 'Authorization' ? `Bearer ${key}` : key } : {};
  const opts = { headers, noCsrf: true };
  return { get: (u) => c.get(u, opts), post: (u, b) => c.post(u, b, opts), patch: (u, b) => c.patch(u, b, opts), del: (u) => c.del(u, opts) };
}

before(async () => {
  srv = await bootServer({ ALLOW_OPEN_SIGNUP: 'true' });
  ({ db } = await import('../server/db.js'));
  owner = client(srv.base);
  member = client(srv.base);
  await owner.post('/api/auth/register', { name: 'Olivia', email: 'olivia@x.com', password: 'first-long-password', companyName: 'API Co' });
  const inv = await owner.post('/api/company/invites', { role: 'member' });
  const joined = await member.post(`/api/auth/invites/${inv.data.url.split('/invite/')[1]}/accept`, { name: 'Milo', email: 'milo@x.com', password: 'second-long-password' });
  memberUserId = joined.data.user.id;
  projectId = (await owner.post('/api/projects', { name: 'Launch' })).data.id;
});
after(async () => { await srv.close(); });

test('keys are created from the app, shown once, and stored only as a hash', async () => {
  const w = await owner.post('/api/keys', { name: 'CI bot', scope: 'write' });
  assert.equal(w.status, 201, JSON.stringify(w.data));
  assert.match(w.data.secret, /^keel_[A-Za-z0-9_-]{40,}$/);
  assert.equal(w.data.key.scope, 'write');
  assert.ok(w.data.secret.startsWith(w.data.key.prefix));
  writeKey = w.data.secret; writeKeyId = w.data.key.id;
  readKey = (await owner.post('/api/keys', { name: 'Dashboard', scope: 'read', expiresInDays: 30 })).data.secret;

  const list = await owner.get('/api/keys');
  assert.equal(list.data.items.length, 2);
  assert.ok(!JSON.stringify(list.data).includes(writeKey), 'the secret is never listed');
  assert.ok(list.data.items.find((k) => k.name === 'Dashboard').expiresAt);

  const row = db.prepare('SELECT key_hash FROM api_keys WHERE id = ?').get(writeKeyId);
  assert.match(row.key_hash, /^[0-9a-f]{64}$/);
  const bad = await owner.post('/api/keys', { name: '', scope: 'admin' });
  assert.equal(bad.status, 400);
});

test('the API needs a valid key and ignores browser sessions', async () => {
  const none = await apiClient(null).get('/api/v1/tasks');
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /Bearer/);
  assert.equal((await apiClient('keel_not-a-real-key').get('/api/v1/tasks')).status, 401);
  assert.equal((await apiClient('sk-something').get('/api/v1/tasks')).status, 401);
  const cookieOnly = await owner.get('/api/v1/tasks');
  assert.equal(cookieOnly.status, 401, 'a signed-in cookie is not accepted on /api/v1');

  const me = await apiClient(writeKey).get('/api/v1/me');
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.equal(me.data.key.name, 'CI bot');
  assert.equal(me.data.actingAs.role, 'owner');
  assert.equal(me.data.company.name, 'API Co');
  assert.equal((await apiClient(writeKey, 'X-API-Key').get('/api/v1/me')).status, 200, 'X-API-Key header also works');
});

test('write keys create and change tasks without any CSRF header', async () => {
  const api = apiClient(writeKey);
  const onProject = await api.post(`/api/v1/projects/${projectId}/tasks`, { title: 'Ship the landing page', priority: 'high', labels: ['launch'], dueDate: '2026-10-01' });
  assert.equal(onProject.status, 201, JSON.stringify(onProject.data));
  assert.equal(onProject.data.projectId, projectId);
  assert.equal(onProject.data.ref, 'AC-1');
  ownerTaskId = onProject.data.id;
  const loose = await api.post('/api/v1/tasks', { title: 'Book the venue' });
  assert.equal(loose.data.ref, 'AC-2');
  assert.equal((await api.post(`/api/v1/projects/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/tasks`, { title: 'x' })).status, 404);
  assert.equal((await api.post('/api/v1/tasks', { priority: 'nope' })).status, 400);

  const byRef = await api.get('/api/v1/tasks/AC-1');
  assert.equal(byRef.status, 200);
  assert.equal(byRef.data.id, ownerTaskId);
  const patched = await api.patch('/api/v1/tasks/ac-1', { status: 'done', description: 'Done via API' });
  assert.equal(patched.data.status, 'done');
  assert.ok(patched.data.completedAt);
  const comment = await api.post('/api/v1/tasks/AC-1/comments', { body: 'Deployed by CI' });
  assert.equal(comment.status, 201);
  assert.equal((await api.get('/api/v1/tasks/AC-1')).data.comments.length, 1);
  const moved = await api.post('/api/v1/tasks/AC-2/move', { status: 'in_progress', index: 0 });
  assert.equal(moved.data.status, 'in_progress');

  const inProject = await api.get(`/api/v1/projects/${projectId}/tasks`);
  assert.deepEqual(inProject.data.items.map((t) => t.ref), ['AC-1']);
  const paged = await api.get('/api/v1/tasks?limit=1');
  assert.equal(paged.data.items.length, 1);
  assert.equal(paged.data.total, 2);
  const future = await api.get(`/api/v1/tasks?updatedSince=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}`);
  assert.equal(future.data.items.length, 0);
  const recent = await api.get(`/api/v1/tasks?updatedSince=${encodeURIComponent(new Date(Date.now() - 60000).toISOString())}`);
  assert.equal(recent.data.items.length, 2);
});

test('projects, expenses, members and categories are reachable', async () => {
  const api = apiClient(writeKey);
  const projects = await api.get('/api/v1/projects');
  assert.equal(projects.data.items[0].name, 'Launch');
  const p = await api.post('/api/v1/projects', { name: 'From the API', budget: 500 });
  assert.equal(p.status, 201);
  assert.equal((await api.patch(`/api/v1/projects/${p.data.id}`, { status: 'on_hold' })).data.status, 'on_hold');
  const cats = await api.get('/api/v1/categories');
  assert.ok(cats.data.items.length > 3);
  const members = await api.get('/api/v1/members');
  assert.equal(members.data.items.length, 2);
  const e = await api.post('/api/v1/expenses', { amount: '249.99', date: '2026-09-10', vendor: 'Vercel', categoryId: cats.data.items[0].id, projectId });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  assert.equal(e.data.amountCents, 24999);
  assert.equal((await api.get('/api/v1/expenses?q=vercel')).data.total, 1);
  assert.equal((await api.get('/api/v1/expenses/summary')).data.totals.allTimeCents, 24999);
  assert.equal((await api.get('/api/v1/company')).data.company.key, 'AC');
});

test('read-only keys can read but not write', async () => {
  const api = apiClient(readKey);
  assert.equal((await api.get('/api/v1/tasks')).status, 200);
  const denied = await api.post('/api/v1/tasks', { title: 'nope' });
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /read-only/);
  assert.equal((await api.patch('/api/v1/tasks/AC-1', { status: 'todo' })).status, 403);
  assert.equal((await api.del('/api/v1/tasks/AC-1')).status, 403);
});

test('a key cannot manage keys, accounts or members', async () => {
  const api = apiClient(writeKey);
  assert.equal((await api.get('/api/keys')).status, 401, 'key management needs a signed-in session');
  assert.equal((await api.post('/api/keys', { name: 'sneaky' })).status, 403, 'blocked by the CSRF guard before auth');
  for (const path of ['/api/v1/keys', '/api/v1/auth/me', '/api/v1/company/invites', '/api/v1/company/members']) {
    assert.equal((await api.get(path)).status, 404, path);
  }
  assert.equal((await api.post('/api/v1/company/invites', { role: 'owner' })).status, 404);
});

test('a key carries the role of the person who made it', async () => {
  const created = await member.post('/api/keys', { name: 'Milo script', scope: 'write' });
  memberKey = created.data.secret;
  const mine = await member.get('/api/keys');
  assert.equal(mine.data.canSeeAll, false);
  assert.deepEqual(mine.data.items.map((k) => k.name), ['Milo script'], 'members only see their own keys');
  assert.equal((await member.del(`/api/keys/${writeKeyId}`)).status, 403);

  const api = apiClient(memberKey);
  assert.equal((await api.get('/api/v1/me')).data.actingAs.role, 'member');
  assert.equal((await api.del(`/api/v1/tasks/${ownerTaskId}`)).status, 403, 'members cannot delete tasks they did not create');
  assert.equal((await api.del(`/api/v1/projects/${projectId}`)).status, 403);
  const own = await api.post('/api/v1/tasks', { title: 'Milo task' });
  assert.equal((await api.del(`/api/v1/tasks/${own.data.id}`)).status, 200);
});

test('revoked, expired and orphaned keys stop working', async () => {
  const temp = await owner.post('/api/keys', { name: 'Temp', scope: 'read', expiresInDays: 1 });
  assert.equal((await apiClient(temp.data.secret).get('/api/v1/me')).status, 200);
  db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), temp.data.key.id);
  const expired = await apiClient(temp.data.secret).get('/api/v1/me');
  assert.equal(expired.status, 401);
  assert.match(expired.data.error, /expired/);

  assert.equal((await owner.del(`/api/keys/${writeKeyId}`)).status, 200);
  assert.equal((await apiClient(writeKey).get('/api/v1/me')).status, 401);
  assert.equal((await owner.get('/api/keys')).data.items.find((k) => k.id === writeKeyId).state, 'revoked');

  assert.equal((await apiClient(memberKey).get('/api/v1/me')).status, 200);
  await owner.del(`/api/company/members/${memberUserId}`);
  assert.equal((await apiClient(memberKey).get('/api/v1/me')).status, 401, 'removing a member kills their keys');
});

test('API changes are attributed in the activity log and usage is tracked', async () => {
  const items = (await owner.get('/api/activity?limit=100')).data.items.map((a) => a.summary);
  assert.ok(items.some((s) => /Olivia \(API: CI bot\) created task AC-1/.test(s)), items.join(' | '));
  assert.ok(items.some((s) => /created the read & write API key "CI bot"/.test(s)));
  assert.ok(items.some((s) => /revoked the API key "CI bot"/.test(s)));
  const key = (await owner.get('/api/keys')).data.items.find((k) => k.id === writeKeyId);
  assert.ok(key.requestCount > 10);
  assert.ok(key.lastUsedAt);
});

test('the OpenAPI document is public and CORS preflights succeed', async () => {
  const spec = await apiClient(null).get('/api/v1/openapi.json');
  assert.equal(spec.status, 200);
  assert.equal(spec.data.openapi, '3.0.3');
  assert.ok(spec.data.paths['/tasks'].post && spec.data.paths['/projects/{id}/tasks'].post);
  assert.match(spec.data.servers[0].url, /\/api\/v1$/);
  const pre = await fetch(`${srv.base}/api/v1/tasks`, { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
});
