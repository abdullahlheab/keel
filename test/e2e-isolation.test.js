// Two companies on one server, and three roles inside one of them. Nothing may leak sideways,
// and every role must be held to the same rules whether it comes through the app or the API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client } from './helpers.js';

let srv;
let owner; let admin; let normalMember; let rival;   // Acme: owner/admin/member. Rival: another company.
const acme = { project: null, task: null, topic: null, expense: null, receipt: null, category: null, memberId: null, adminId: null, topicPost: null };
const other = { project: null, task: null, topic: null, expense: null, receipt: null };

function apiClient(secret) {
  const c = client(srv.base);
  const opts = { headers: { Authorization: `Bearer ${secret}` }, noCsrf: true };
  return { get: (u) => c.get(u, opts), post: (u, b) => c.post(u, b, opts), patch: (u, b) => c.patch(u, b, opts), del: (u) => c.del(u, opts) };
}

async function join(inviter, role, who) {
  const inv = await inviter.post('/api/company/invites', { role });
  const c = client(srv.base);
  const res = await c.post(`/api/auth/invites/${inv.data.url.split('/invite/')[1]}/accept`, who);
  return { c, userId: res.data.user.id };
}

before(async () => {
  srv = await bootServer({ ALLOW_OPEN_SIGNUP: 'true' });
  owner = client(srv.base);
  await owner.post('/api/auth/register', { name: 'Olive', email: 'olive@acme.test', password: 'owner-side-password', companyName: 'Acme' });
  ({ c: admin, userId: acme.adminId } = await join(owner, 'admin', { name: 'Adam', email: 'adam@acme.test', password: 'admin-side-password' }));
  ({ c: normalMember, userId: acme.memberId } = await join(owner, 'member', { name: 'Mira', email: 'mira@acme.test', password: 'member-side-password' }));

  rival = client(srv.base);
  await rival.post('/api/auth/register', { name: 'Rex', email: 'rex@rival.test', password: 'rival-side-password', companyName: 'Rival' });

  acme.category = (await owner.get('/api/company')).data.categories[0].id;
  acme.project = (await owner.post('/api/projects', { name: 'Secret roadmap' })).data.id;
  acme.task = (await owner.post('/api/tasks', { title: 'Confidential task', projectId: acme.project })).data.id;
  acme.expense = (await owner.post('/api/expenses', { amount: 500, date: '2026-09-01', vendor: 'Private vendor' })).data.id;
  const topic = await owner.post('/api/discussions', { title: 'Internal only', body: 'Board matters' });
  acme.topic = topic.data.id;
  acme.topicPost = (await owner.post(`/api/discussions/${acme.topic}/posts`, { body: 'Nobody outside should read this' })).data.id;
  acme.receipt = (await owner.post(`/api/expenses/${acme.expense}/receipts`, Buffer.from('%PDF-1.4 secret'), { headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'secret.pdf' } })).data.id;

  other.project = (await rival.post('/api/projects', { name: 'Rival plans' })).data.id;
  other.task = (await rival.post('/api/tasks', { title: 'Rival task' })).data.id;
  other.expense = (await rival.post('/api/expenses', { amount: 7, date: '2026-09-02', vendor: 'Rival vendor' })).data.id;
  other.topic = (await rival.post('/api/discussions', { title: 'Rival topic' })).data.id;
});
after(async () => { await srv.close(); });

test('a rival company sees none of our rows, by id or in any list', async () => {
  // Direct fetches by a known id.
  const reads = [
    `/api/projects/${acme.project}`, `/api/tasks/${acme.task}`, `/api/expenses/${acme.expense}`,
    `/api/discussions/${acme.topic}`, `/api/receipts/${acme.receipt}`,
  ];
  for (const url of reads) assert.equal((await rival.get(url)).status, 404, `${url} must be invisible`);

  // And nothing of ours appears in their lists.
  assert.ok(!(await rival.get('/api/projects')).data.items.some((p) => p.id === acme.project));
  assert.ok(!(await rival.get('/api/tasks')).data.items.some((t) => t.id === acme.task));
  assert.ok(!(await rival.get('/api/expenses')).data.items.some((e) => e.id === acme.expense));
  assert.ok(!(await rival.get('/api/discussions')).data.items.some((t) => t.id === acme.topic));
  assert.ok(!(await rival.get('/api/activity?limit=200')).data.items.some((a) => (a.summary || '').includes('Confidential')));
  assert.ok(!(await rival.get('/api/company')).data.members.some((m) => m.email.endsWith('@acme.test')));

  const csv = await rival.get('/api/expenses/export.csv');
  assert.ok(!csv.data.includes('Private vendor'), 'and not in their CSV export either');
});

test('a rival cannot write to our rows either', async () => {
  const writes = [
    ['patch', `/api/projects/${acme.project}`, { name: 'Pwned' }],
    ['del', `/api/projects/${acme.project}`],
    ['patch', `/api/tasks/${acme.task}`, { title: 'Pwned' }],
    ['del', `/api/tasks/${acme.task}`],
    ['post', `/api/tasks/${acme.task}/comments`, { body: 'hello' }],
    ['patch', `/api/expenses/${acme.expense}`, { amount: 1 }],
    ['del', `/api/expenses/${acme.expense}`],
    ['patch', `/api/discussions/${acme.topic}`, { title: 'Pwned' }],
    ['del', `/api/discussions/${acme.topic}`],
    ['post', `/api/discussions/${acme.topic}/posts`, { body: 'hello' }],
    ['del', `/api/receipts/${acme.receipt}`],
    ['patch', `/api/company/members/${acme.memberId}`, { role: 'member' }],
    ['del', `/api/company/members/${acme.memberId}`],
  ];
  for (const [method, url, body] of writes) {
    const res = body === undefined ? await rival[method](url) : await rival[method](url, body);
    assert.ok([403, 404].includes(res.status), `${method.toUpperCase()} ${url} returned ${res.status}`);
  }
  // The rows are untouched.
  assert.equal((await owner.get(`/api/projects/${acme.project}`)).data.project.name, 'Secret roadmap');
  assert.equal((await owner.get(`/api/tasks/${acme.task}`)).data.title, 'Confidential task');
});

test('bulk endpoints cannot be used to reach across companies', async () => {
  for (const [url, ids] of [['/api/tasks/bulk', [other.task, acme.task]], ['/api/expenses/bulk', [other.expense, acme.expense]], ['/api/discussions/bulk', [other.topic, acme.topic]]]) {
    const res = await rival.post(url, { ids, action: 'delete' });
    assert.equal(res.status, 404, `${url} must refuse a batch that reaches outside the company`);
  }
  assert.equal((await owner.get(`/api/tasks/${acme.task}`)).status, 200, 'ours survived');
  assert.equal((await rival.get(`/api/tasks/${other.task}`)).status, 200, 'and so did theirs - the batch was all-or-nothing');
});

test('an API key is locked to its own company', async () => {
  const secret = (await rival.post('/api/keys', { name: 'Rival bot', scope: 'write', password: 'rival-side-password' })).data.secret;
  const bot = apiClient(secret);
  assert.equal((await bot.get('/api/v1/me')).data.company.name, 'Rival');
  for (const url of [`/api/v1/projects/${acme.project}`, `/api/v1/tasks/${acme.task}`, `/api/v1/expenses/${acme.expense}`, `/api/v1/discussions/${acme.topic}`]) {
    assert.equal((await bot.get(url)).status, 404, url);
  }
  assert.ok(!(await bot.get('/api/v1/tasks')).data.items.some((t) => t.id === acme.task));
});

test('the X-Company-Id header cannot be pointed at a company you are not in', async () => {
  const acmeCompanyId = (await owner.get('/api/company')).data.company.id;
  const c = client(srv.base);
  await c.post('/api/auth/login', { email: 'rex@rival.test', password: 'rival-side-password' });
  c.setCompany(acmeCompanyId);
  const res = await c.get('/api/tasks');
  assert.equal(res.status, 403);
  assert.match(res.data.error, /not a member/i);
});

test('a member is held to their own rows; an admin is not', async () => {
  const mineTask = (await normalMember.post('/api/tasks', { title: 'Mira task' })).data.id;
  const mineExpense = (await normalMember.post('/api/expenses', { amount: 20, date: '2026-09-03', vendor: 'Mira lunch' })).data.id;

  // Members may edit shared work but not delete what they did not create.
  assert.equal((await normalMember.patch(`/api/tasks/${acme.task}`, { status: 'review' })).status, 200, 'tasks are shared work');
  assert.equal((await normalMember.del(`/api/tasks/${acme.task}`)).status, 403, 'but deleting belongs to the creator or an admin');
  assert.equal((await normalMember.del(`/api/tasks/${mineTask}`)).status, 200, 'their own is fine');

  // Expenses are stricter: only the person who added or paid may edit.
  assert.equal((await normalMember.patch(`/api/expenses/${acme.expense}`, { vendor: 'Changed' })).status, 403);
  assert.equal((await normalMember.patch(`/api/expenses/${mineExpense}`, { vendor: 'Mira dinner' })).status, 200);
  assert.equal((await admin.patch(`/api/expenses/${mineExpense}`, { vendor: 'Reviewed' })).status, 200, 'an admin can edit anyone\'s');

  // Admin-only doors.
  assert.equal((await normalMember.post('/api/company/invites', { role: 'member' })).status, 403);
  assert.equal((await normalMember.post('/api/company/categories', { name: 'Nope' })).status, 403);
  assert.equal((await normalMember.patch('/api/company', { name: 'Renamed' })).status, 403);
  assert.equal((await normalMember.del(`/api/projects/${acme.project}`)).status, 403);
  assert.equal((await admin.post('/api/company/invites', { role: 'member' })).status, 201);
});

test('only an owner can touch owner roles, and the last owner is protected', async () => {
  assert.equal((await admin.patch(`/api/company/members/${acme.memberId}`, { role: 'owner' })).status, 403, 'an admin cannot mint an owner');
  assert.equal((await admin.post('/api/company/invites', { role: 'owner' })).status, 403);

  // An owner can move people around - put Mira back afterwards, the later tests need a plain member.
  assert.equal((await owner.patch(`/api/company/members/${acme.memberId}`, { role: 'admin' })).status, 200);
  const restored = await owner.patch(`/api/company/members/${acme.memberId}`, { role: 'member' });
  assert.equal(restored.data.items.find((m) => m.id === acme.memberId).role, 'member');

  const ownerId = (await owner.get('/api/auth/me')).data.user.id;
  assert.equal((await owner.del(`/api/company/members/${ownerId}`)).status, 409, 'the last owner cannot walk out');
  assert.equal((await owner.patch(`/api/company/members/${ownerId}`, { role: 'admin' })).status, 409, 'nor demote themselves');
  assert.equal((await admin.del(`/api/company/members/${ownerId}`)).status, 403, 'and an admin cannot remove them');
});

test('discussion moderation and authorship rules hold for every role', async () => {
  const memberTopic = (await normalMember.post('/api/discussions', { title: 'Member topic' })).data.id;
  assert.equal((await normalMember.patch(`/api/discussions/${memberTopic}`, { pinned: true })).status, 403, 'members cannot pin their own topic');
  assert.equal((await admin.patch(`/api/discussions/${memberTopic}`, { pinned: true })).status, 200);
  assert.equal((await normalMember.patch(`/api/discussions/${acme.topic}`, { title: 'Hijack' })).status, 403, 'nor retitle someone else\'s');
  assert.equal((await normalMember.patch(`/api/discussions/${acme.topic}/posts/${acme.topicPost}`, { body: 'Hijack' })).status, 403, 'nor rewrite their words');
  assert.equal((await normalMember.patch(`/api/discussions/${acme.topic}/posts/${acme.topicPost}`, { answer: true })).status, 403, 'nor pick the answer on a topic they did not start');
  assert.equal((await admin.patch(`/api/discussions/${acme.topic}/posts/${acme.topicPost}`, { answer: true })).status, 200, 'an admin may');

  await admin.patch(`/api/discussions/${memberTopic}`, { locked: true });
  assert.equal((await normalMember.post(`/api/discussions/${memberTopic}/posts`, { body: 'one more' })).status, 403, 'a lock stops the author too');
  assert.equal((await admin.post(`/api/discussions/${memberTopic}/posts`, { body: 'closing' })).status, 201);
});

test('a key never exceeds the role of the person who created it', async () => {
  const memberKey = (await normalMember.post('/api/keys', { name: 'Mira script', scope: 'write', password: 'member-side-password' })).data.secret;
  const bot = apiClient(memberKey);

  assert.equal((await bot.get('/api/v1/me')).data.actingAs.role, 'member');
  assert.equal((await bot.post('/api/v1/company/categories', { name: 'Via key' })).status, 403, 'admin doors stay shut');
  assert.equal((await bot.patch('/api/v1/company', { name: 'Renamed by key' })).status, 403);
  assert.equal((await bot.del(`/api/v1/projects/${acme.project}`)).status, 403);
  assert.equal((await bot.patch(`/api/v1/expenses/${acme.expense}`, { vendor: 'Nope' })).status, 403, 'and the expense rule still applies');
  assert.equal((await bot.post('/api/v1/tasks', { title: 'Allowed' })).status, 201, 'what a member may do, their key may do');
});

test('read-only keys are read-only on every write path, including bulk and uploads', async () => {
  const readKey = (await owner.post('/api/keys', { name: 'Reader', scope: 'read', password: 'owner-side-password' })).data.secret;
  const ro = apiClient(readKey);
  assert.equal((await ro.get('/api/v1/discussions')).status, 200);
  const writes = [
    ['post', '/api/v1/tasks', { title: 'no' }],
    ['post', '/api/v1/discussions', { title: 'no' }],
    ['post', `/api/v1/discussions/${acme.topic}/posts`, { body: 'no' }],
    ['post', '/api/v1/tasks/bulk', { ids: [acme.task], action: 'delete' }],
    ['post', '/api/v1/discussions/bulk', { ids: [acme.topic], action: 'pin' }],
    ['post', '/api/v1/expenses/bulk', { ids: [acme.expense], action: 'delete' }],
    ['patch', `/api/v1/projects/${acme.project}`, { name: 'no' }],
    ['del', `/api/v1/receipts/${acme.receipt}`],
  ];
  for (const [method, url, body] of writes) {
    const res = body === undefined ? await ro[method](url) : await ro[method](url, body);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${url}`);
    assert.match(res.data.error, /read-only/i);
  }
});

test('leaving the company cuts off everything that person could reach', async () => {
  const doomedKey = (await normalMember.post('/api/keys', { name: 'Doomed', scope: 'read', password: 'member-side-password' })).data.secret;
  const bot = apiClient(doomedKey);
  assert.equal((await bot.get('/api/v1/tasks')).status, 200, 'works while they are a member');

  assert.equal((await owner.del(`/api/company/members/${acme.memberId}`)).status, 200);

  assert.equal((await bot.get('/api/v1/tasks')).status, 401, 'the key dies with the membership');
  const after = await normalMember.get('/api/tasks');
  assert.equal(after.status, 409, 'and their session no longer resolves a company');
});
