// Board analytics: cumulative flow, burnup, velocity and cycle time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client } from './helpers.js';

let srv; let owner; let projectId; let otherProjectId;
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  srv = await bootServer();
  owner = client(srv.base);
  await owner.post('/api/auth/register', { name: 'Ana', email: 'ana@x.test', password: 'first-long-password', companyName: 'Flow Co' });
  projectId = (await owner.post('/api/projects', { name: 'Tracked' })).data.id;
  otherProjectId = (await owner.post('/api/projects', { name: 'Untracked' })).data.id;
});
after(async () => { await srv.close(); });

test('an empty board reports zeroes rather than falling over', async () => {
  const res = await owner.get('/api/insights');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.to, today);
  assert.deepEqual(res.data.statuses, ['backlog', 'todo', 'in_progress', 'review', 'done']);
  assert.equal(res.data.totals.tracked, 0);
  assert.equal(res.data.cycleTime.averageDays, null, 'no completed work means no average, not zero');
  assert.ok(Array.isArray(res.data.flow) && res.data.flow.length >= 1);
  assert.ok(res.data.flow.every((row) => row.date && row.done === 0));
});

test('creating and moving work shows up in the flow and burnup', async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await owner.post('/api/tasks', { title: `Flow ${i}`, projectId })).data.id);

  await owner.patch(`/api/tasks/${ids[0]}`, { status: 'in_progress' });
  await owner.patch(`/api/tasks/${ids[1]}`, { status: 'in_progress' });
  await owner.patch(`/api/tasks/${ids[2]}`, { status: 'review' });
  await owner.patch(`/api/tasks/${ids[3]}`, { status: 'done' });

  const res = await owner.get('/api/insights');
  const last = res.data.flow[res.data.flow.length - 1];
  assert.equal(last.todo, 1, 'one never moved');
  assert.equal(last.in_progress, 2);
  assert.equal(last.review, 1);
  assert.equal(last.done, 1);

  const columnSum = res.data.statuses.reduce((n, s) => n + last[s], 0);
  assert.equal(columnSum, 5, 'every tracked task sits in exactly one column');

  const burn = res.data.burnup[res.data.burnup.length - 1];
  assert.equal(burn.total, 5, 'burnup total is the whole scope');
  assert.equal(burn.done, 1);
  assert.equal(burn.date, today);
  assert.equal(res.data.totals.open, 4);
  assert.equal(res.data.totals.tracked, 5);
});

test('reopening a finished task takes it back out of done', async () => {
  const id = (await owner.post('/api/tasks', { title: 'Round trip', projectId, status: 'done' })).data.id;
  let last = (await owner.get('/api/insights')).data.flow.pop();
  const doneWhenClosed = last.done;

  await owner.patch(`/api/tasks/${id}`, { status: 'todo' });
  last = (await owner.get('/api/insights')).data.flow.pop();
  assert.equal(last.done, doneWhenClosed - 1, 'it left the done column');

  const res = await owner.get('/api/insights');
  assert.ok(res.data.totals.completedInWindow >= 1, 'the work that really finished is still counted');
  await owner.del(`/api/tasks/${id}`);
});

test('velocity counts what finished, by week', async () => {
  const res = await owner.get('/api/insights');
  const finished = res.data.velocity.reduce((n, w) => n + w.completed, 0);
  assert.equal(finished, res.data.totals.done, 'the weekly figures add up to the completed total');
  assert.ok(res.data.velocity.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.week)));
  const mondays = res.data.velocity.map((w) => new Date(`${w.week}T00:00:00Z`).getUTCDay());
  assert.ok(mondays.every((d) => d === 1), 'weeks are keyed by their Monday');
  assert.equal(res.data.totals.weeklyAverage, Math.round((finished / res.data.velocity.length) * 10) / 10);
});

test('cycle time measures first sighting to done', async () => {
  const res = await owner.get('/api/insights');
  assert.ok(res.data.cycleTime.completed >= 1);
  assert.equal(res.data.cycleTime.averageDays, 0, 'work created and finished today took under a day');
  assert.equal(res.data.cycleTime.medianDays, 0);
});

test('the project filter narrows the numbers, and `none` finds unfiled work', async () => {
  await owner.post('/api/tasks', { title: 'No project here' });
  await owner.post('/api/tasks', { title: 'Other project', projectId: otherProjectId, status: 'done' });

  const scoped = await owner.get(`/api/projects/${projectId}/insights`);
  assert.equal(scoped.data.totals.tracked, 5, 'only the five tasks in this project');
  assert.equal(scoped.data.totals.done, 1);

  const viaQuery = await owner.get(`/api/insights?project=${projectId}`);
  assert.deepEqual(viaQuery.data.totals, scoped.data.totals, 'the query parameter and the path agree');

  const unfiled = await owner.get('/api/insights?project=none');
  assert.equal(unfiled.data.totals.tracked, 1);

  const everything = await owner.get('/api/insights');
  assert.equal(everything.data.totals.tracked, 7);
  assert.equal((await owner.get(`/api/projects/00000000-0000-4000-8000-000000000000/insights`)).status, 404);
});

test('the window is bounded and the timeline is continuous', async () => {
  const week = await owner.get('/api/insights?days=7');
  assert.ok(week.data.flow.length <= 7);

  const silly = await owner.get('/api/insights?days=99999');
  assert.ok(silly.data.days <= 730, 'clamped to two years');
  const tiny = await owner.get('/api/insights?days=1');
  assert.ok(tiny.data.days >= 1, 'clamped upward, not rejected');
  assert.equal((await owner.get('/api/insights?days=abc')).status, 200, 'nonsense falls back to the default');

  const long = await owner.get('/api/insights?days=30');
  const dates = long.data.flow.map((r) => r.date);
  assert.deepEqual(dates, [...dates].sort(), 'days run forwards');
  assert.equal(new Set(dates).size, dates.length, 'with no repeats');
  for (let i = 1; i < dates.length; i++) {
    const gap = Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`);
    assert.equal(gap, 86400000, 'and no gaps');
  }
});

test('deleting a project keeps the history of the work that was in it', async () => {
  const before = (await owner.get('/api/insights')).data.totals.tracked;
  await owner.del(`/api/projects/${otherProjectId}`);
  const after = await owner.get('/api/insights');
  assert.equal(after.data.totals.tracked, before, 'company-wide history is unchanged');
  const orphaned = await owner.get('/api/insights?project=none');
  assert.ok(orphaned.data.totals.tracked >= 1);
});

test('insights are reachable with an API key and documented', async () => {
  const secret = (await owner.post('/api/keys', { name: 'Charts', scope: 'read', password: 'first-long-password' })).data.secret;
  const opts = { headers: { Authorization: `Bearer ${secret}` }, noCsrf: true };
  const viaKey = await client(srv.base).get('/api/v1/insights', opts);
  assert.equal(viaKey.status, 200);
  assert.ok(viaKey.data.flow.length >= 1);
  assert.equal((await client(srv.base).get(`/api/v1/projects/${projectId}/insights`, opts)).status, 200);

  const doc = (await owner.get('/api/v1/openapi.json')).data;
  assert.ok(doc.paths['/insights'].get);
  assert.ok(doc.paths['/projects/{id}/insights'].get);
  assert.ok(doc.components.schemas.Insights);
});
