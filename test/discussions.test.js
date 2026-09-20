import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client } from './helpers.js';

let srv; let owner; let member;
let projectId; let topicId; let topicRef; let memberTopicId;

// A client that sends only an API key: no cookies, no CSRF header.
function apiClient(key) {
  const c = client(srv.base);
  const opts = { headers: { Authorization: `Bearer ${key}` }, noCsrf: true };
  return { get: (u) => c.get(u, opts), post: (u, b) => c.post(u, b, opts), patch: (u, b) => c.patch(u, b, opts), del: (u) => c.del(u, opts) };
}

before(async () => {
  srv = await bootServer({ ALLOW_OPEN_SIGNUP: 'true' });
  owner = client(srv.base);
  member = client(srv.base);
  await owner.post('/api/auth/register', { name: 'Ada', email: 'ada@x.com', password: 'first-long-password', companyName: 'Forum Co' });
  const inv = await owner.post('/api/company/invites', { role: 'member' });
  await member.post(`/api/auth/invites/${inv.data.url.split('/invite/')[1]}/accept`, { name: 'Bo', email: 'bo@x.com', password: 'second-long-password' });
  projectId = (await owner.post('/api/projects', { name: 'Launch' })).data.id;
});
after(async () => { await srv.close(); });

test('a topic gets a readable reference and can be fetched by it', async () => {
  const r = await owner.post('/api/discussions', { title: 'What should we call the beta?', body: 'Ideas welcome.', category: 'question', projectId });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  topicId = r.data.id; topicRef = r.data.ref;
  assert.equal(topicRef, 'FC-D1', 'the company key plus D plus the number');
  assert.equal(r.data.state, 'open');
  assert.equal(r.data.category, 'question');
  assert.equal(r.data.projectId, projectId);
  assert.equal(r.data.replyCount, 0);
  assert.equal(r.data.pinned, false);

  const byRef = await owner.get(`/api/discussions/${topicRef}`);
  assert.equal(byRef.status, 200);
  assert.equal(byRef.data.id, topicId);
  assert.deepEqual(byRef.data.posts, []);
  assert.equal((await owner.get('/api/discussions/D1')).data.id, topicId, 'the bare D-number works too');
  assert.equal((await owner.get('/api/discussions/FC-D99')).status, 404);

  const second = await member.post('/api/discussions', { title: 'Coffee machine is broken' });
  memberTopicId = second.data.id;
  assert.equal(second.data.ref, 'FC-D2', 'numbers are per company and keep counting');
});

test('replies thread one level deep and bump the topic', async () => {
  const first = await member.post(`/api/discussions/${topicId}/posts`, { body: 'Keel Beta?' });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.parentId, null);
  assert.equal(first.data.isAnswer, false);

  const reply = await owner.post(`/api/discussions/${topicRef}/posts`, { body: 'I like it.', parentId: first.data.id });
  assert.equal(reply.data.parentId, first.data.id);

  // Replying to a reply attaches to the same parent rather than nesting further.
  const deep = await member.post(`/api/discussions/${topicId}/posts`, { body: 'Me too.', parentId: reply.data.id });
  assert.equal(deep.data.parentId, first.data.id, 'threads stay one level deep');

  const unknown = await owner.post(`/api/discussions/${topicId}/posts`, { body: 'x', parentId: memberTopicId });
  assert.equal(unknown.status, 400);
  assert.ok(unknown.data.fields.parentId);

  const topic = await owner.get(`/api/discussions/${topicId}`);
  assert.equal(topic.data.posts.length, 3);
  assert.ok(topic.data.lastPostAt > topic.data.createdAt, 'the topic floats up the list');

  const list = await owner.get('/api/discussions');
  assert.equal(list.data.items[0].id, topicId, 'most recent activity first');
  assert.equal(list.data.items[0].replyCount, 3);
});

test('only the author or an admin can edit words, and only the asker marks the answer', async () => {
  const posts = (await owner.get(`/api/discussions/${topicId}/posts`)).data.items;
  const bosPost = posts.find((p) => p.body === 'Keel Beta?');

  const edited = await member.patch(`/api/discussions/${topicId}/posts/${bosPost.id}`, { body: 'Keel Beta, maybe?' });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.body, 'Keel Beta, maybe?');
  assert.ok(edited.data.updatedAt, 'an edit is stamped');

  const owners = (await owner.get(`/api/discussions/${topicId}/posts`)).data.items.find((p) => p.body === 'I like it.');
  const denied = await member.patch(`/api/discussions/${topicId}/posts/${owners.id}`, { body: 'hijacked' });
  assert.equal(denied.status, 403, 'a member cannot rewrite someone else');

  // Bo did not start this topic, so Bo cannot pick the answer.
  const notYours = await member.patch(`/api/discussions/${topicId}/posts/${bosPost.id}`, { answer: true });
  assert.equal(notYours.status, 403);

  const marked = await owner.patch(`/api/discussions/${topicId}/posts/${bosPost.id}`, { answer: true });
  assert.equal(marked.status, 200);
  assert.equal(marked.data.isAnswer, true);
  const resolved = await owner.get(`/api/discussions/${topicId}`);
  assert.equal(resolved.data.state, 'resolved');
  assert.equal(resolved.data.answerPostId, bosPost.id);

  const reopened = await owner.patch(`/api/discussions/${topicId}/posts/${bosPost.id}`, { answer: false });
  assert.equal(reopened.data.isAnswer, false);
  const back = await owner.get(`/api/discussions/${topicId}`);
  assert.equal(back.data.state, 'open');
  assert.equal(back.data.answerPostId, null);
});

test('pinning and locking need the admin role, and a lock stops replies', async () => {
  const denied = await member.patch(`/api/discussions/${memberTopicId}`, { pinned: true });
  assert.equal(denied.status, 403, 'a member cannot pin even their own topic');

  const pinned = await owner.patch(`/api/discussions/${memberTopicId}`, { pinned: true });
  assert.equal(pinned.data.pinned, true);
  const list = await owner.get('/api/discussions');
  assert.equal(list.data.items[0].id, memberTopicId, 'pinned topics sort first regardless of activity');

  await owner.patch(`/api/discussions/${memberTopicId}`, { locked: true });
  const blocked = await member.post(`/api/discussions/${memberTopicId}/posts`, { body: 'one more thing' });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /locked/i);
  const admin = await owner.post(`/api/discussions/${memberTopicId}/posts`, { body: 'Closing this off.' });
  assert.equal(admin.status, 201, 'an admin can still post');

  await owner.patch(`/api/discussions/${memberTopicId}`, { locked: false, pinned: false });
});

test('a member can edit and delete their own topic but not someone else\'s', async () => {
  const before = (await member.get(`/api/discussions/${memberTopicId}`)).data;
  assert.equal(before.editedAt, null, 'pinning and locking are not edits');

  const mine = await member.patch(`/api/discussions/${memberTopicId}`, { title: 'Coffee machine is fixed', state: 'resolved' });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.title, 'Coffee machine is fixed');
  assert.equal(mine.data.state, 'resolved');
  assert.ok(mine.data.editedAt, 'changing the words is');

  const moderated = await owner.patch(`/api/discussions/${memberTopicId}`, { pinned: true });
  assert.equal(moderated.data.editedAt, mine.data.editedAt, 'and later moderation leaves the edit stamp alone');
  await owner.patch(`/api/discussions/${memberTopicId}`, { pinned: false });

  const theirs = await member.patch(`/api/discussions/${topicId}`, { title: 'nope' });
  assert.equal(theirs.status, 403);
  assert.equal((await member.del(`/api/discussions/${topicId}`)).status, 403);

  const empty = await owner.patch(`/api/discussions/${topicId}`, {});
  assert.equal(empty.status, 400);
});

test('archived topics stay out of the default list', async () => {
  const spare = (await owner.post('/api/discussions', { title: 'Old news', category: 'announcement' })).data;
  await owner.patch(`/api/discussions/${spare.id}`, { state: 'archived' });

  const list = await owner.get('/api/discussions');
  assert.ok(!list.data.items.some((t) => t.id === spare.id), 'hidden by default');
  assert.ok((await owner.get('/api/discussions?includeArchived=1')).data.items.some((t) => t.id === spare.id));
  assert.ok((await owner.get('/api/discussions?state=archived')).data.items.some((t) => t.id === spare.id));

  const blocked = await member.post(`/api/discussions/${spare.id}/posts`, { body: 'hello?' });
  assert.equal(blocked.status, 403);
  await owner.del(`/api/discussions/${spare.id}`);
});

test('filters and search narrow the list', async () => {
  assert.equal((await owner.get('/api/discussions?category=question')).data.items.length, 1);
  assert.equal((await owner.get(`/api/discussions?project=${projectId}`)).data.items.length, 1);
  assert.equal((await owner.get('/api/discussions?project=none')).data.items.length, 1);
  assert.equal((await owner.get('/api/discussions?state=resolved')).data.items.length, 1);
  assert.equal((await owner.get('/api/discussions?q=beta')).data.items[0].id, topicId, 'search covers the title');
  assert.equal((await owner.get('/api/discussions?q=fc-d1')).data.items[0].id, topicId, 'an exact reference matches');
  assert.equal((await owner.get('/api/discussions?limit=1')).data.items.length, 1);
  assert.equal((await owner.get('/api/discussions?limit=1')).data.total, 2, 'total counts before paging');

  const scoped = await owner.get(`/api/projects/${projectId}/discussions`);
  assert.equal(scoped.data.items.length, 1);
  const onProject = await owner.post(`/api/projects/${projectId}/discussions`, { title: 'Scope check' });
  assert.equal(onProject.data.projectId, projectId, 'the project comes from the URL');
  await owner.del(`/api/discussions/${onProject.data.id}`);
});

test('deleting a reply clears the answer and rewinds the last activity', async () => {
  const topic = (await owner.get(`/api/discussions/${topicId}`)).data;
  const last = topic.posts[topic.posts.length - 1];
  await owner.patch(`/api/discussions/${topicId}/posts/${last.id}`, { answer: true });

  const notMine = await member.del(`/api/discussions/${topicId}/posts/${topic.posts[1].id}`);
  assert.equal(notMine.status, 403, 'replies belong to their author');

  const gone = await owner.del(`/api/discussions/${topicId}/posts/${last.id}`);
  assert.equal(gone.status, 200);
  const after = (await owner.get(`/api/discussions/${topicId}`)).data;
  assert.equal(after.answerPostId, null, 'the answer pointer is cleared');
  assert.equal(after.posts.length, 2);
  assert.equal(after.lastPostAt, after.posts[after.posts.length - 1].createdAt, 'last activity rewinds to the newest remaining reply');
});

test('bulk actions work on a selection, with the same permission rules', async () => {
  const ids = [];
  for (const title of ['Bulk one', 'Bulk two', 'Bulk three']) ids.push((await owner.post('/api/discussions', { title })).data.id);

  const pinned = await owner.post('/api/discussions/bulk', { ids: ids.slice(0, 2), action: 'pin' });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.data));
  assert.ok(pinned.data.items.every((t) => t.pinned));

  const byMember = await member.post('/api/discussions/bulk', { ids, action: 'lock' });
  assert.equal(byMember.status, 403, 'moderation is admin only');

  const moved = await owner.post('/api/discussions/bulk', { ids, action: 'update', data: { category: 'idea', state: 'resolved' } });
  assert.ok(moved.data.items.every((t) => t.category === 'idea' && t.state === 'resolved'));

  const notTheirs = await member.post('/api/discussions/bulk', { ids, action: 'delete' });
  assert.equal(notTheirs.status, 403);

  const nothing = await owner.post('/api/discussions/bulk', { ids, action: 'update', data: {} });
  assert.equal(nothing.status, 400);
  assert.equal((await owner.post('/api/discussions/bulk', { ids: [memberTopicId, '00000000-0000-4000-8000-000000000000'], action: 'pin' })).status, 404, 'an unknown id fails the whole batch');
  assert.equal((await owner.post('/api/discussions/bulk', { ids: ['not-a-uuid'], action: 'pin' })).status, 400);

  const deleted = await owner.post('/api/discussions/bulk', { ids, action: 'delete' });
  assert.equal(deleted.data.deleted, 3);
  assert.equal((await owner.get(`/api/discussions/${ids[0]}`)).status, 404);
});

test('the discussion room is reachable with an API key, and shows up in the activity log', async () => {
  const write = (await owner.post('/api/keys', { name: 'Bot', scope: 'write', password: 'first-long-password' })).data.secret;
  const read = (await owner.post('/api/keys', { name: 'Reader', scope: 'read', password: 'first-long-password' })).data.secret;
  const bot = apiClient(write);
  const reader = apiClient(read);

  const created = await bot.post('/api/v1/discussions', { title: 'Raised by a script', category: 'idea' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.match(created.data.ref, /^FC-D\d+$/);

  const replied = await bot.post(`/api/v1/discussions/${created.data.ref}/posts`, { body: 'and answered by one too' });
  assert.equal(replied.status, 201);

  const seen = await reader.get('/api/v1/discussions');
  assert.ok(seen.data.items.some((t) => t.id === created.data.id));
  assert.equal((await reader.get(`/api/v1/discussions/${created.data.id}/posts`)).data.items.length, 1);
  assert.equal((await reader.post('/api/v1/discussions', { title: 'nope' })).status, 403, 'read-only keys cannot write');

  const feed = (await owner.get('/api/activity?entityType=discussion')).data.items;
  assert.ok(feed.some((a) => a.summary.includes('(API: Bot)')), 'API changes are labelled with the key name');
  assert.ok(feed.some((a) => a.action === 'created' && a.summary.includes('Raised by a script')));

  await bot.del(`/api/v1/discussions/${created.data.id}`);
});

test('the OpenAPI document describes every discussion route it serves', async () => {
  const doc = (await owner.get('/api/v1/openapi.json')).data;
  for (const path of ['/discussions', '/discussions/{id}', '/discussions/{id}/posts', '/discussions/{id}/posts/{postId}', '/discussions/bulk', '/projects/{id}/discussions']) {
    assert.ok(doc.paths[path], `${path} is documented`);
  }
  assert.ok(doc.components.schemas.Topic && doc.components.schemas.TopicInput && doc.components.schemas.Post);
  assert.ok(doc.tags.some((t) => t.name === 'Discussions'));
});
