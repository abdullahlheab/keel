// Discussion room: forum topics with threaded replies.
import { Router } from 'express';
import { db, tx, now, one, all } from '../db.js';
import { uid, encrypt } from '../crypto.js';
import { validate, rules } from '../validate.js';
import { HttpError, notFound, forbidden } from '../middleware/errors.js';
import { hasRole } from '../middleware/auth.js';
import { logActivity } from '../services/activity.js';
import { topicRow, postRow, nextTopicNumber } from '../services/repo.js';

const router = Router();
export const CATEGORIES = ['general', 'announcement', 'question', 'idea', 'decision'];
export const STATES = ['open', 'resolved', 'archived'];
const STATE_LABEL = { open: 'open', resolved: 'resolved', archived: 'archived' };

const schema = {
  title: rules.string({ required: true, min: 1, max: 200 }),
  body: rules.string({ max: 20000 }),
  category: rules.enum(CATEGORIES, { default: 'general' }),
  state: rules.enum(STATES, { default: 'open' }),
  projectId: rules.id(),
  pinned: rules.bool(),
  locked: rules.bool(),
};

const TOPIC_SELECT = `SELECT t.*,
  (SELECT count(*) FROM discussion_posts p WHERE p.topic_id = t.id) AS reply_count,
  (SELECT p.user_id FROM discussion_posts p WHERE p.topic_id = t.id ORDER BY p.created_at DESC LIMIT 1) AS last_post_by,
  (SELECT co.key FROM companies co WHERE co.id = t.company_id) AS company_key
  FROM discussion_topics t`;

// Matches a topic reference: ACME-D12, or just D12.
const TOPIC_REF = /^(?:[A-Za-z][A-Za-z0-9]{0,9}-)?D(\d{1,9})$/i;

function loadTopic(companyId, idOrRef) {
  const m = TOPIC_REF.exec(String(idOrRef).trim());
  const row = m
    ? one(`${TOPIC_SELECT} WHERE t.number = ? AND t.company_id = ?`, Number(m[1]), companyId)
    : one(`${TOPIC_SELECT} WHERE t.id = ? AND t.company_id = ?`, idOrRef, companyId);
  return row ? topicRow(row) : null;
}

function mustLoad(req) {
  const topic = loadTopic(req.company.id, req.params.id);
  if (!topic) throw notFound('Topic');
  return topic;
}

function topicRef(req, topic) { return `${req.company.key}-D${topic.number}`; }

// The author of a topic or post, and any admin, may change it.
function canManage(req, ownerId) { return hasRole(req, 'admin') || ownerId === req.user.id; }

function checkRefs(companyId, body) {
  if (body.projectId && !one('SELECT id FROM projects WHERE id = ? AND company_id = ?', body.projectId, companyId)) {
    throw new HttpError(400, 'Please fix the highlighted fields', { fields: { projectId: 'Unknown project' } });
  }
}

// pinned and locked are moderation flags, so they need the admin role.
function checkModeration(req, body) {
  if (('pinned' in body || 'locked' in body) && !hasRole(req, 'admin')) {
    throw forbidden('Only an admin or owner can pin or lock a topic');
  }
}

function listTopics(req, q) {
  let items = all(`${TOPIC_SELECT} WHERE t.company_id = ? ORDER BY t.pinned DESC, t.last_post_at DESC`, req.company.id).map(topicRow);
  if (q.project === 'none') items = items.filter((t) => !t.projectId);
  else if (q.project) items = items.filter((t) => t.projectId === q.project);
  if (q.category) items = items.filter((t) => t.category === q.category);
  if (q.author) items = items.filter((t) => t.createdBy === q.author);
  if (q.state) items = items.filter((t) => t.state === q.state);
  else if (!['1', 'true'].includes(String(q.includeArchived))) items = items.filter((t) => t.state !== 'archived');
  if (q.pinned !== undefined && q.pinned !== '') {
    const want = ['1', 'true'].includes(String(q.pinned));
    items = items.filter((t) => t.pinned === want);
  }
  if (q.q) {
    const needle = String(q.q).toLowerCase();
    items = items.filter((t) => t.title.toLowerCase().includes(needle) || (t.body || '').toLowerCase().includes(needle) || `${req.company.key}-D${t.number}`.toLowerCase() === needle);
  }
  if (q.updatedSince) items = items.filter((t) => t.updatedAt > String(q.updatedSince) || t.lastPostAt > String(q.updatedSince));
  const offset = Math.max(Number(q.offset) || 0, 0);
  const limit = Number(q.limit) > 0 ? Math.min(Number(q.limit), 500) : null;
  const total = items.length;
  if (offset || limit) items = items.slice(offset, limit ? offset + limit : undefined);
  return { items, total };
}

function loadPosts(topic, since) {
  let rows = all('SELECT * FROM discussion_posts WHERE topic_id = ? ORDER BY created_at ASC', topic.id);
  if (since) rows = rows.filter((r) => r.created_at > String(since) || (r.updated_at || '') > String(since));
  return rows.map((r) => postRow(r, topic.answerPostId));
}

// Keeps last_post_at truthful so the list can order by recent activity.
function touchTopic(topicId, ts) {
  db.prepare('UPDATE discussion_topics SET last_post_at = ? WHERE id = ?').run(ts, topicId);
}
function recomputeLastPost(topicId) {
  db.prepare(`UPDATE discussion_topics SET last_post_at = coalesce((SELECT max(created_at) FROM discussion_posts WHERE topic_id = ?), created_at) WHERE id = ?`).run(topicId, topicId);
}

// ---------- topics ----------
router.get('/discussions', (req, res) => res.json(listTopics(req, req.query)));

router.get('/projects/:projectId/discussions', (req, res) => {
  if (!one('SELECT id FROM projects WHERE id = ? AND company_id = ?', req.params.projectId, req.company.id)) throw notFound('Project');
  res.json(listTopics(req, { ...req.query, project: req.params.projectId }));
});

router.post('/discussions', (req, res) => res.status(201).json(createTopic(req, req.body)));

router.post('/projects/:projectId/discussions', (req, res) => {
  if (!one('SELECT id FROM projects WHERE id = ? AND company_id = ?', req.params.projectId, req.company.id)) throw notFound('Project');
  const raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  res.status(201).json(createTopic(req, { ...raw, projectId: req.params.projectId }));
});

function createTopic(req, raw) {
  const body = validate(schema, raw);
  checkRefs(req.company.id, body);
  checkModeration(req, body);
  const id = uid();
  const ts = now();
  const topic = tx(() => {
    const number = nextTopicNumber(db, req.company.id);
    db.prepare(`INSERT INTO discussion_topics (id, company_id, project_id, number, title_enc, body_enc, category, state, pinned, locked, created_by, created_at, updated_at, last_post_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.company.id, body.projectId ?? null, number, encrypt(body.title), encrypt(body.body ?? null), body.category, body.state,
        body.pinned ? 1 : 0, body.locked ? 1 : 0, req.user.id, ts, ts, ts);
    return loadTopic(req.company.id, id);
  });
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'created', entityType: 'discussion', entityId: id, summary: `${req.user.name} started the discussion ${topicRef(req, topic)} "${topic.title}"` });
  return topic;
}

// ---------- bulk actions on a selection ----------
const BULK_ACTIONS = ['update', 'pin', 'unpin', 'lock', 'unlock', 'delete'];

router.post('/discussions/bulk', (req, res) => {
  const body = validate({ ids: rules.array(rules.id(), { required: true, max: 200 }), action: rules.enum(BULK_ACTIONS, { required: true }) }, req.body);
  const ids = [...new Set(body.ids)];
  if (!ids.length) throw new HttpError(400, 'Select at least one topic');
  const data = req.body.data && typeof req.body.data === 'object' && !Array.isArray(req.body.data) ? req.body.data : {};
  const placeholders = ids.map(() => '?').join(',');
  const found = new Map(all(`${TOPIC_SELECT} WHERE t.company_id = ? AND t.id IN (${placeholders})`, req.company.id, ...ids).map((r) => [r.id, topicRow(r)]));
  if (found.size !== ids.length) throw notFound('One or more topics');
  const topics = ids.map((id) => found.get(id));
  const ts = now();
  const n = topics.length;
  const noun = `${n} topic${n === 1 ? '' : 's'}`;
  const refs = topics.map((t) => topicRef(req, t)).join(', ');
  const log = (action, summary) => logActivity({ companyId: req.company.id, userId: req.user.id, action, entityType: 'discussion', entityId: n === 1 ? topics[0].id : null, summary: `${req.user.name} ${summary}`, meta: { ids, refs } });
  const reload = () => ({ items: ids.map((id) => loadTopic(req.company.id, id)) });

  if (body.action === 'delete') {
    const blocked = topics.filter((t) => !canManage(req, t.createdBy));
    if (blocked.length) throw forbidden('You can only delete topics you started');
    tx(() => { const del = db.prepare('DELETE FROM discussion_topics WHERE id = ?'); for (const t of topics) del.run(t.id); });
    log('deleted', `deleted ${noun} (${refs})`);
    return res.json({ deleted: n });
  }

  if (['pin', 'unpin', 'lock', 'unlock'].includes(body.action)) {
    if (!hasRole(req, 'admin')) throw forbidden('Only an admin or owner can pin or lock a topic');
    const column = body.action.endsWith('pin') ? 'pinned' : 'locked';
    const value = ['pin', 'lock'].includes(body.action) ? 1 : 0;
    tx(() => {
      const upd = db.prepare(`UPDATE discussion_topics SET ${column} = ?, updated_at = ? WHERE id = ?`);
      for (const t of topics) upd.run(value, ts, t.id);
    });
    log('updated', `${body.action === 'pin' ? 'pinned' : body.action === 'unpin' ? 'unpinned' : body.action === 'lock' ? 'locked' : 'unlocked'} ${noun} (${refs})`);
    return res.json(reload());
  }

  const patch = validate({ category: rules.enum(CATEGORIES), state: rules.enum(STATES), projectId: rules.id() }, data, { partial: true });
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change');
  checkRefs(req.company.id, patch);
  const blocked = topics.filter((t) => !canManage(req, t.createdBy));
  if (blocked.length) throw forbidden('You can only change topics you started');
  tx(() => {
    const upd = db.prepare('UPDATE discussion_topics SET category = ?, state = ?, project_id = ?, updated_at = ? WHERE id = ?');
    for (const t of topics) upd.run(patch.category ?? t.category, patch.state ?? t.state, 'projectId' in patch ? patch.projectId : t.projectId, ts, t.id);
  });
  let summary = `updated ${noun}`;
  if (patch.state) summary = `marked ${noun} as ${STATE_LABEL[patch.state]}`;
  else if (patch.category) summary = `moved ${noun} to ${patch.category}`;
  log('updated', `${summary} (${refs})`);
  res.json(reload());
});

router.get('/discussions/:id', (req, res) => {
  const topic = mustLoad(req);
  res.json({ ...topic, posts: loadPosts(topic) });
});

router.patch('/discussions/:id', (req, res) => {
  const current = mustLoad(req);
  const body = validate(schema, req.body, { partial: true });
  if (!Object.keys(body).length) throw new HttpError(400, 'Nothing to change');
  checkRefs(req.company.id, body);
  checkModeration(req, body);
  // Anyone may not edit someone else's words; pin/lock are handled above and allowed for admins.
  const contentKeys = ['title', 'body', 'category', 'state', 'projectId'].filter((k) => k in body);
  if (contentKeys.length && !canManage(req, current.createdBy)) throw forbidden('Only the person who started the topic, or an admin, can change it');
  const next = { ...current, ...body };
  const ts = now();
  // Only a change to the words counts as an edit; pinning or resolving does not.
  const reworded = ('title' in body && body.title !== current.title) || ('body' in body && (body.body ?? null) !== current.body);
  db.prepare(`UPDATE discussion_topics SET project_id = ?, title_enc = ?, body_enc = ?, category = ?, state = ?, pinned = ?, locked = ?, updated_at = ?, edited_at = ? WHERE id = ?`)
    .run(next.projectId ?? null, encrypt(next.title), encrypt(next.body ?? null), next.category, next.state, next.pinned ? 1 : 0, next.locked ? 1 : 0, ts, reworded ? ts : current.editedAt, current.id);
  const changed = Object.keys(body);
  let verb = `updated the discussion ${topicRef(req, current)}`;
  if (changed.length === 1 && 'state' in body) verb = `marked ${topicRef(req, current)} as ${STATE_LABEL[body.state]}`;
  else if (changed.length === 1 && 'pinned' in body) verb = `${body.pinned ? 'pinned' : 'unpinned'} ${topicRef(req, current)}`;
  else if (changed.length === 1 && 'locked' in body) verb = `${body.locked ? 'locked' : 'unlocked'} ${topicRef(req, current)}`;
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'updated', entityType: 'discussion', entityId: current.id, summary: `${req.user.name} ${verb}`, meta: { changed } });
  res.json(loadTopic(req.company.id, current.id));
});

router.delete('/discussions/:id', (req, res) => {
  const current = mustLoad(req);
  if (!canManage(req, current.createdBy)) throw forbidden('Only the person who started the topic, or an admin, can delete it');
  db.prepare('DELETE FROM discussion_topics WHERE id = ?').run(current.id);
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'deleted', entityType: 'discussion', entityId: current.id, summary: `${req.user.name} deleted the discussion ${topicRef(req, current)} "${current.title}"` });
  res.json({ ok: true });
});

// ---------- replies ----------
router.get('/discussions/:id/posts', (req, res) => {
  const topic = mustLoad(req);
  const items = loadPosts(topic, req.query.updatedSince);
  res.json({ items, total: items.length });
});

router.post('/discussions/:id/posts', (req, res) => {
  const topic = mustLoad(req);
  if (topic.locked && !hasRole(req, 'admin')) throw forbidden('This topic is locked');
  if (topic.state === 'archived' && !hasRole(req, 'admin')) throw forbidden('This topic is archived');
  const body = validate({ body: rules.string({ required: true, min: 1, max: 20000 }), parentId: rules.id() }, req.body);
  if (body.parentId) {
    const parent = one('SELECT * FROM discussion_posts WHERE id = ? AND topic_id = ?', body.parentId, topic.id);
    if (!parent) throw new HttpError(400, 'Please fix the highlighted fields', { fields: { parentId: 'That reply is not in this topic' } });
    // Replies stay one level deep: replying to a reply attaches to its parent.
    if (parent.parent_id) body.parentId = parent.parent_id;
  }
  const id = uid();
  const ts = now();
  tx(() => {
    db.prepare('INSERT INTO discussion_posts (id, company_id, topic_id, parent_id, user_id, body_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.company.id, topic.id, body.parentId ?? null, req.user.id, encrypt(body.body), ts);
    touchTopic(topic.id, ts);
  });
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'commented', entityType: 'discussion', entityId: topic.id, summary: `${req.user.name} replied to ${topicRef(req, topic)} "${topic.title}"` });
  res.status(201).json(postRow(one('SELECT * FROM discussion_posts WHERE id = ?', id), topic.answerPostId));
});

router.patch('/discussions/:id/posts/:postId', (req, res) => {
  const topic = mustLoad(req);
  const post = one('SELECT * FROM discussion_posts WHERE id = ? AND topic_id = ?', req.params.postId, topic.id);
  if (!post) throw notFound('Reply');
  const fields = validate({ body: rules.string({ min: 1, max: 20000 }), answer: rules.bool() }, req.body, { partial: true });
  if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to change');

  if ('body' in fields) {
    if (!canManage(req, post.user_id)) throw forbidden('You can only edit your own replies');
    db.prepare('UPDATE discussion_posts SET body_enc = ?, updated_at = ? WHERE id = ?').run(encrypt(fields.body), now(), post.id);
  }
  if ('answer' in fields) {
    // Marking the answer belongs to whoever asked, or an admin.
    if (!canManage(req, topic.createdBy)) throw forbidden('Only the person who started the topic, or an admin, can mark the answer');
    const ts = now();
    db.prepare('UPDATE discussion_topics SET answer_post_id = ?, state = ?, updated_at = ? WHERE id = ?')
      .run(fields.answer ? post.id : null, fields.answer ? 'resolved' : 'open', ts, topic.id);
    logActivity({ companyId: req.company.id, userId: req.user.id, action: 'updated', entityType: 'discussion', entityId: topic.id, summary: fields.answer ? `${req.user.name} marked an answer on ${topicRef(req, topic)}` : `${req.user.name} reopened ${topicRef(req, topic)}` });
  }
  const fresh = loadTopic(req.company.id, topic.id);
  res.json(postRow(one('SELECT * FROM discussion_posts WHERE id = ?', post.id), fresh.answerPostId));
});

router.delete('/discussions/:id/posts/:postId', (req, res) => {
  const topic = mustLoad(req);
  const post = one('SELECT * FROM discussion_posts WHERE id = ? AND topic_id = ?', req.params.postId, topic.id);
  if (!post) throw notFound('Reply');
  if (!canManage(req, post.user_id)) throw forbidden('You can only delete your own replies');
  tx(() => {
    if (topic.answerPostId === post.id) db.prepare('UPDATE discussion_topics SET answer_post_id = NULL WHERE id = ?').run(topic.id);
    db.prepare('DELETE FROM discussion_posts WHERE id = ?').run(post.id);
    recomputeLastPost(topic.id);
  });
  res.json({ ok: true });
});

export default router;
