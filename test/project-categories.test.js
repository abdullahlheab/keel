// Project categories: their own set, separate from expense categories.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client } from './helpers.js';

let srv; let owner; let member; let projectId;

before(async () => {
  srv = await bootServer();
  owner = client(srv.base);
  await owner.post('/api/auth/register', { name: 'Pia', email: 'pia@x.test', password: 'first-long-password', companyName: 'Category Co' });
  const inv = await owner.post('/api/company/invites', { role: 'member' });
  member = client(srv.base);
  await member.post(`/api/auth/invites/${inv.data.url.split('/invite/')[1]}/accept`, { name: 'Mo', email: 'mo@x.test', password: 'second-long-password' });
});
after(async () => { await srv.close(); });

// Ids minted in SQL have to match the ones minted in JS, or they are rejected the moment a client
// sends one back. A fresh company seeds through uid(), so only the migration backfill uses the SQL
// expression - which is exactly why this needs testing directly.
test('ids generated in SQL have the same shape as randomUUID()', async () => {
  const { db, SQL_UUID } = await import('../server/db.js');
  const { rules } = await import('../server/validate.js');
  const { pattern } = rules.id();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const id = db.prepare(`SELECT ${SQL_UUID} AS id`).get().id;
    assert.match(id, pattern, `${id} is not a usable id`);
    assert.equal(id.length, 36);
    assert.equal(id[14], '4', 'version nibble');
    assert.ok('89ab'.includes(id[19]), 'variant nibble');
    seen.add(id);
  }
  assert.equal(seen.size, 200, 'and they are unique');
});

test('a new company starts with a usable set, kept apart from expense categories', async () => {
  const res = await owner.get('/api/company/project-categories');
  assert.equal(res.status, 200);
  const names = res.data.items.map((c) => c.name);
  assert.deepEqual(names, ['Client work', 'Internal', 'Product', 'Research', 'Operations']);
  assert.ok(res.data.items.every((c) => c.color && c.archived === false));
  const { rules } = await import('../server/validate.js');
  assert.ok(res.data.items.every((c) => rules.id().pattern.test(c.id)), 'every id can be sent back in');

  const expense = (await owner.get('/api/company/categories')).data.items.map((c) => c.name);
  assert.ok(expense.includes('Marketing'), 'expense categories are untouched');
  assert.ok(!expense.includes('Client work'), 'and the two sets do not bleed into each other');

  const bootstrap = await owner.get('/api/company');
  assert.equal(bootstrap.data.projectCategories.length, 5);
  assert.ok(bootstrap.data.categories.length >= 10);
});

test('the same name can be an expense category and a project category', async () => {
  const made = await owner.post('/api/company/project-categories', { name: 'Marketing', color: '#eb6834' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.name, 'Marketing');
  assert.equal((await owner.post('/api/company/project-categories', { name: 'marketing' })).status, 409, 'but not twice within the same set');
  await owner.del(`/api/company/project-categories/${made.data.id}`);
});

test('a project carries a category, and the list can be filtered by it', async () => {
  const cats = (await owner.get('/api/company/project-categories')).data.items;
  const client_ = cats.find((c) => c.name === 'Client work');
  const internal = cats.find((c) => c.name === 'Internal');

  const p = await owner.post('/api/projects', { name: 'Acme rebuild', categoryId: client_.id });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  assert.equal(p.data.categoryId, client_.id);
  projectId = p.data.id;

  await owner.post('/api/projects', { name: 'Internal tooling', categoryId: internal.id });
  await owner.post('/api/projects', { name: 'Unfiled work' });

  assert.equal((await owner.get(`/api/projects?category=${client_.id}`)).data.items.length, 1);
  assert.equal((await owner.get('/api/projects?category=none')).data.items.length, 1);
  assert.equal((await owner.get('/api/projects')).data.items.length, 3);

  const moved = await owner.patch(`/api/projects/${projectId}`, { categoryId: internal.id });
  assert.equal(moved.data.categoryId, internal.id);
  const cleared = await owner.patch(`/api/projects/${projectId}`, { categoryId: null });
  assert.equal(cleared.data.categoryId, null, 'a project can have no category');
  await owner.patch(`/api/projects/${projectId}`, { categoryId: client_.id });
});

test('a category from another company, or one that does not exist, is refused', async () => {
  const bad = await owner.post('/api/projects', { name: 'Nope', categoryId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.fields.categoryId, /Unknown project category/);

  // An expense category id is not a project category id, even though both exist in this company.
  const expenseCat = (await owner.get('/api/company/categories')).data.items[0].id;
  const wrongKind = await owner.post('/api/projects', { name: 'Wrong kind', categoryId: expenseCat });
  assert.equal(wrongKind.status, 400, 'the two sets are not interchangeable');
});

test('managing project categories needs the admin role', async () => {
  assert.equal((await member.get('/api/company/project-categories')).status, 200, 'anyone can read them');
  assert.equal((await member.post('/api/company/project-categories', { name: 'Sneaky' })).status, 403);
  const cats = (await owner.get('/api/company/project-categories')).data.items;
  assert.equal((await member.patch(`/api/company/project-categories/${cats[0].id}`, { name: 'Renamed' })).status, 403);
  assert.equal((await member.del(`/api/company/project-categories/${cats[0].id}`)).status, 403);
});

test('archiving hides a category from new work without touching history', async () => {
  const cats = (await owner.get('/api/company/project-categories')).data.items;
  const research = cats.find((c) => c.name === 'Research');
  const archived = await owner.patch(`/api/company/project-categories/${research.id}`, { archived: true });
  assert.equal(archived.data.archived, true);
  assert.ok((await owner.get('/api/company/project-categories')).data.items.some((c) => c.id === research.id), 'still listed, just flagged');
  await owner.patch(`/api/company/project-categories/${research.id}`, { archived: false });
});

test('deleting a category leaves its projects behind, uncategorised', async () => {
  const made = (await owner.post('/api/company/project-categories', { name: 'Temporary' })).data;
  await owner.patch(`/api/projects/${projectId}`, { categoryId: made.id });

  const del = await owner.del(`/api/company/project-categories/${made.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.detachedProjects, 1, 'the response says how many were affected');

  const p = await owner.get(`/api/projects/${projectId}`);
  assert.equal(p.status, 200, 'the project survives');
  assert.equal(p.data.project.categoryId, null);
});

test('changes are recorded, and the whole thing works with an API key', async () => {
  const feed = (await owner.get('/api/activity?entityType=category&limit=50')).data.items.map((a) => a.summary);
  assert.ok(feed.some((s) => s.includes('added the project category')));
  assert.ok(feed.some((s) => s.includes('deleted the project category')));
  assert.ok(feed.some((s) => s.includes('archived the project category')));

  const secret = (await owner.post('/api/keys', { name: 'Cat bot', scope: 'write', password: 'first-long-password' })).data.secret;
  const bot = client(srv.base);
  const opts = { headers: { Authorization: `Bearer ${secret}` }, noCsrf: true };

  const made = await bot.post('/api/v1/company/project-categories', { name: 'From a script', color: '#1baf7a' }, opts);
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const p = await bot.post('/api/v1/projects', { name: 'Scripted project', categoryId: made.data.id }, opts);
  assert.equal(p.data.categoryId, made.data.id);
  assert.equal((await bot.get(`/api/v1/projects?category=${made.data.id}`, opts)).data.items.length, 1);

  const doc = (await owner.get('/api/v1/openapi.json')).data;
  assert.ok(doc.paths['/company/project-categories'].get && doc.paths['/company/project-categories'].post);
  assert.ok(doc.paths['/company/project-categories/{id}'].patch && doc.paths['/company/project-categories/{id}'].delete);
  assert.ok(doc.components.schemas.Project.properties.categoryId, 'the project schema advertises the field');
});
