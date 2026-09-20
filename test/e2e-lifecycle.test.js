// The parts of Keel that are about the account and the workspace rather than the work itself:
// invites, sessions, two-factor gating, company settings, categories, and the activity feed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client } from './helpers.js';

let srv; let owner; let ownerId;

before(async () => {
  srv = await bootServer();
  owner = client(srv.base);
  const reg = await owner.post('/api/auth/register', { name: 'Nia', email: 'nia@x.test', password: 'first-long-password', companyName: 'Lifecycle Labs' });
  ownerId = reg.data.user.id;
});
after(async () => { await srv.close(); });

test('an invite pinned to an email only works for that email', async () => {
  const inv = await owner.post('/api/company/invites', { email: 'expected@x.test', role: 'member' });
  const token = inv.data.url.split('/invite/')[1];
  assert.equal(inv.data.invite.email, 'expected@x.test');
  assert.equal(inv.data.invite.state, 'pending');

  const wrong = client(srv.base);
  const mismatch = await wrong.post(`/api/auth/invites/${token}/accept`, { name: 'Imposter', email: 'someone.else@x.test', password: 'imposter-long-password' });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.data.fields.email, /expected@x.test/);

  const right = client(srv.base);
  const ok = await right.post(`/api/auth/invites/${token}/accept`, { name: 'Expected Person', email: 'expected@x.test', password: 'expected-long-password' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.companies[0].role, 'member');
});

test('a revoked invite stops working, and the list reflects every state', async () => {
  const live = await owner.post('/api/company/invites', { role: 'member' });
  const liveToken = live.data.url.split('/invite/')[1];
  assert.equal((await owner.del(`/api/company/invites/${live.data.invite.id}`)).status, 200);

  const tryIt = client(srv.base);
  const res = await tryIt.post(`/api/auth/invites/${liveToken}/accept`, { name: 'Late', email: 'late@x.test', password: 'late-long-password' });
  assert.equal(res.status, 410);

  const preview = await tryIt.get(`/api/auth/invites/${liveToken}`);
  assert.equal(preview.data.state, 'revoked', 'the link explains itself rather than 404ing');

  const list = await owner.get('/api/company/invites');
  const states = list.data.items.map((i) => i.state);
  assert.ok(states.includes('revoked') && states.includes('accepted'));
  assert.ok(!JSON.stringify(list.data).includes(liveToken), 'tokens are never listed back');

  assert.equal((await tryIt.get('/api/auth/invites/not-a-real-token')).status, 404);
});

test('an already-registered person joins a second company without a new account', async () => {
  const solo = client(srv.base);
  const other = await bootInSameServer(solo);
  const inv = await owner.post('/api/company/invites', { role: 'member' });
  const joined = await solo.post(`/api/auth/invites/${inv.data.url.split('/invite/')[1]}/accept`, {});
  assert.equal(joined.status, 200);
  assert.equal(joined.data.companies.length, 2, 'they now belong to two companies');

  // And the two workspaces stay separate when switching between them.
  solo.setCompany(joined.data.companyId);
  assert.ok((await solo.get('/api/company')).data.company.name === 'Lifecycle Labs');
  solo.setCompany(other);
  assert.equal((await solo.get('/api/company')).data.company.name, 'Solo Co');

  const twice = await solo.post(`/api/company/invites`, { role: 'member' });
  assert.ok([201, 403].includes(twice.status));
});

async function bootInSameServer(c) {
  // ALLOW_OPEN_SIGNUP is off, so a second company is seeded straight through the database.
  const { db } = await import('../server/db.js');
  const { uid, hashPassword } = await import('../server/crypto.js');
  const ts = new Date().toISOString();
  const userId = uid(); const companyId = uid();
  db.prepare('INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, 'solo@x.test', 'Solo', await hashPassword('solo-long-password'), ts, ts);
  db.prepare('INSERT INTO companies (id, name, key, currency, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(companyId, 'Solo Co', 'SOLO', 'USD', userId, ts, ts);
  db.prepare('INSERT INTO memberships (id, company_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)').run(uid(), companyId, userId, 'owner', ts);
  await c.post('/api/auth/login', { email: 'solo@x.test', password: 'solo-long-password' });
  return companyId;
}

test('a half-finished two-factor sign-in cannot read anything', async () => {
  const c = client(srv.base);
  await c.post('/api/auth/login', { email: 'nia@x.test', password: 'first-long-password' });
  assert.equal((await c.post('/api/auth/me/mfa/setup', {})).status, 400, 'setup asks for the password again');
  const setup = await c.post('/api/auth/me/mfa/setup', { password: 'first-long-password' });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  assert.ok(setup.data.secret && setup.data.qrDataUrl, 'setup returns a secret and a QR code');
  assert.match(setup.data.otpauthUrl, /^otpauth:\/\/totp\/Keel/);
  const { totpCode } = await import('../server/crypto.js');
  const enabled = await c.post('/api/auth/me/mfa/enable', { code: totpCode(setup.data.secret) });
  assert.equal(enabled.status, 200);
  assert.ok(enabled.data.recoveryCodes.length > 0);

  // A fresh sign-in now stops half way.
  const half = client(srv.base);
  const login = await half.post('/api/auth/login', { email: 'nia@x.test', password: 'first-long-password' });
  assert.equal(login.data.mfaRequired, true);

  for (const url of ['/api/tasks', '/api/company', '/api/expenses', '/api/discussions', '/api/activity', '/api/keys']) {
    const res = await half.get(url);
    assert.equal(res.status, 401, `${url} must stay shut until the code is entered`);
    assert.equal(res.data.mfaRequired, true);
  }
  assert.equal((await half.post('/api/tasks', { title: 'sneaky' })).status, 401);

  const done = await half.post('/api/auth/mfa', { code: totpCode(setup.data.secret) });
  assert.equal(done.status, 200);
  assert.equal((await half.get('/api/tasks')).status, 200, 'and opens once it is');

  const off = await c.post('/api/auth/me/mfa/disable', { password: 'first-long-password', code: totpCode(setup.data.secret) });
  assert.equal(off.status, 200, JSON.stringify(off.data));
});

test('sessions can be listed and revoked, and a revoked one dies immediately', async () => {
  const phone = client(srv.base);
  await phone.post('/api/auth/login', { email: 'nia@x.test', password: 'first-long-password' });
  assert.equal((await phone.get('/api/tasks')).status, 200);

  const sessions = await owner.get('/api/auth/me/sessions');
  assert.ok(sessions.data.items.length >= 2);
  assert.equal(sessions.data.items.filter((s) => s.current).length, 1, 'exactly one is marked current');
  assert.ok(!JSON.stringify(sessions.data).includes('token_hash'), 'no token material is exposed');

  const others = await owner.post('/api/auth/me/sessions/revoke-others');
  assert.ok(others.data.revoked >= 1);
  assert.equal((await phone.get('/api/tasks')).status, 401, 'the other device is signed out at once');
  assert.equal((await owner.get('/api/tasks')).status, 200, 'the current one survives');
});

test('company settings can be renamed, and task references follow the new key', async () => {
  const task = await owner.post('/api/tasks', { title: 'Reference check' });
  assert.match(task.data.ref, /^LL-\d+$/);

  const renamed = await owner.patch('/api/company', { name: 'Lifecycle Industries', key: 'LIFE', currency: 'GBP' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.company.key, 'LIFE');

  const after = await owner.get(`/api/tasks/${task.data.id}`);
  assert.equal(after.data.ref, `LIFE-${task.data.number}`, 'existing work picks up the new key');
  assert.equal((await owner.get(`/api/tasks/LIFE-${task.data.number}`)).status, 200, 'and is reachable by the new reference');

  const newExpense = await owner.post('/api/expenses', { amount: 10, date: '2026-09-09' });
  assert.equal(newExpense.data.currency, 'GBP', 'new spend uses the new currency');

  for (const bad of [{ key: 'toolongkey' }, { key: '1AB' }, { currency: 'pounds' }, { name: '' }]) {
    assert.equal((await owner.patch('/api/company', bad)).status, 400, JSON.stringify(bad));
  }
});

test('expense categories can be created, renamed, reordered, archived and removed', async () => {
  assert.equal((await owner.post('/api/company/categories', { name: 'travel' })).status, 409, 'a seeded category cannot be duplicated, whatever the case');

  const made = await owner.post('/api/company/categories', { name: 'Research', color: '#2a78d6' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.archived, false);

  const dupe = await owner.post('/api/company/categories', { name: 'RESEARCH' });
  assert.equal(dupe.status, 409, 'names are unique regardless of case');

  const renamed = await owner.patch(`/api/company/categories/${made.data.id}`, { name: 'Research & development', sortOrder: 0 });
  assert.equal(renamed.data.name, 'Research & development');

  const archived = await owner.patch(`/api/company/categories/${made.data.id}`, { archived: true });
  assert.equal(archived.data.archived, true);
  const visible = await owner.get('/api/company/categories');
  assert.ok(visible.data.items.find((c) => c.id === made.data.id).archived, 'archived ones are still listed, just flagged');

  assert.equal((await owner.del(`/api/company/categories/${made.data.id}`)).status, 200);
  assert.equal((await owner.patch(`/api/company/categories/${made.data.id}`, { name: 'Gone' })).status, 404);
});

test('the activity feed pages backwards without repeating or skipping', async () => {
  for (let i = 0; i < 12; i++) await owner.post('/api/tasks', { title: `Feed filler ${i}` });

  const first = await owner.get('/api/activity?limit=5');
  assert.equal(first.data.items.length, 5);
  assert.equal(first.data.hasMore, true);
  assert.ok(first.data.nextBefore);

  const second = await owner.get(`/api/activity?limit=5&before=${encodeURIComponent(first.data.nextBefore)}`);
  assert.equal(second.data.items.length, 5);

  const firstIds = new Set(first.data.items.map((a) => a.id));
  assert.ok(second.data.items.every((a) => !firstIds.has(a.id)), 'no entry appears on two pages');

  const timestamps = [...first.data.items, ...second.data.items].map((a) => a.createdAt);
  const sorted = [...timestamps].sort().reverse();
  assert.deepEqual(timestamps, sorted, 'the feed stays in newest-first order across pages');

  const capped = await owner.get('/api/activity?limit=9999');
  assert.ok(capped.data.items.length <= 200, 'the page size is capped');
});

test('every kind of change lands in the audit trail, and each item has its own history', async () => {
  const cat = (await owner.post('/api/company/categories', { name: 'Audited' })).data.id;
  await owner.patch(`/api/company/categories/${cat}`, { archived: true });
  await owner.del(`/api/company/categories/${cat}`);

  const inv = await owner.post('/api/company/invites', { role: 'member' });
  await owner.del(`/api/company/invites/${inv.data.invite.id}`);

  const expense = (await owner.post('/api/expenses', { amount: 12, date: '2026-09-10', vendor: 'Receipted' })).data.id;
  const receipt = (await owner.post(`/api/expenses/${expense}/receipts`, Buffer.from('%PDF-1.4 x'), { headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'bill.pdf' } })).data.id;
  await owner.del(`/api/receipts/${receipt}`);

  const feed = (await owner.get('/api/activity?limit=200')).data.items.map((a) => a.summary);
  for (const phrase of ['added the expense category', 'archived the expense category', 'deleted the expense category', 'revoked the invite', 'attached the receipt', 'removed the receipt']) {
    assert.ok(feed.some((s) => s.includes(phrase)), `the log should mention "${phrase}"`);
  }
  assert.ok((await owner.get('/api/activity?entityType=category')).data.items.length >= 3, 'categories are filterable');

  // Per-item history: the same feed, narrowed to one thing.
  const task = (await owner.post('/api/tasks', { title: 'Has a history' })).data;
  await owner.patch(`/api/tasks/${task.id}`, { status: 'in_progress' });
  await owner.patch(`/api/tasks/${task.id}`, { status: 'done' });
  await owner.post(`/api/tasks/${task.id}/comments`, { body: 'note' });

  const history = await owner.get(`/api/activity?entityType=task&entityId=${task.id}`);
  assert.ok(history.data.items.length >= 4, 'created, two moves and a comment');
  assert.ok(history.data.items.every((a) => a.entityId === task.id), 'nothing from other items leaks in');
  const actions = history.data.items.map((a) => a.action);
  assert.ok(actions.includes('created') && actions.includes('moved') && actions.includes('commented'));
});

test('work done with an API key is attributed to the key in every item history', async () => {
  const secret = (await owner.post('/api/keys', { name: 'Auditor', scope: 'write', password: 'first-long-password' })).data.secret;
  const bot = client(srv.base);
  const opts = { headers: { Authorization: `Bearer ${secret}` }, noCsrf: true };

  const task = (await bot.post('/api/v1/tasks', { title: 'Raised by a robot' }, opts)).data;
  await bot.patch(`/api/v1/tasks/${task.id}`, { status: 'done' }, opts);
  const topic = (await bot.post('/api/v1/discussions', { title: 'Robot topic' }, opts)).data;

  const taskHistory = (await owner.get(`/api/activity?entityType=task&entityId=${task.id}`)).data.items;
  assert.ok(taskHistory.every((a) => a.summary.includes('(API: Auditor)')), 'the key name is on every entry');
  assert.ok(taskHistory.some((a) => a.action === 'moved'));

  const topicHistory = (await owner.get(`/api/activity?entityType=discussion&entityId=${topic.id}`)).data.items;
  assert.ok(topicHistory.some((a) => a.summary.includes('(API: Auditor)')));

  // And the history is readable back through the API itself.
  const viaKey = await bot.get(`/api/v1/activity?entityType=task&entityId=${task.id}`, opts);
  assert.equal(viaKey.status, 200);
  assert.equal(viaKey.data.items.length, taskHistory.length);
});

test('changing the password signs out everyone else and kills the keys', async () => {
  const key = (await owner.post('/api/keys', { name: 'Doomed by reset', scope: 'read', password: 'first-long-password' })).data.secret;
  const bot = client(srv.base);
  assert.equal((await bot.get('/api/v1/tasks', { headers: { Authorization: `Bearer ${key}` }, noCsrf: true })).status, 200);

  const other = client(srv.base);
  await other.post('/api/auth/login', { email: 'nia@x.test', password: 'first-long-password' });

  const changed = await owner.post('/api/auth/me/password', { currentPassword: 'first-long-password', newPassword: 'a-brand-new-password' });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.ok(changed.data.revokedKeys >= 1, 'the response says how many keys went');

  assert.equal((await bot.get('/api/v1/tasks', { headers: { Authorization: `Bearer ${key}` }, noCsrf: true })).status, 401, 'the key is dead');
  assert.equal((await other.get('/api/tasks')).status, 401, 'the other session is signed out');
  assert.equal((await owner.get('/api/tasks')).status, 200, 'the one that made the change stays in');

  assert.equal((await client(srv.base).post('/api/auth/login', { email: 'nia@x.test', password: 'first-long-password' })).status, 401, 'the old password is gone');
  assert.equal((await client(srv.base).post('/api/auth/login', { email: 'nia@x.test', password: 'a-brand-new-password' })).status, 200);
});
