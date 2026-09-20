// Task board: tasks, ordering within columns, comments.
import { Router } from 'express';
import { db, tx, now, one, all } from '../db.js';
import { uid, encrypt, encryptJSON } from '../crypto.js';
import { validate, rules } from '../validate.js';
import { HttpError, notFound, forbidden } from '../middleware/errors.js';
import { hasRole } from '../middleware/auth.js';
import { logActivity } from '../services/activity.js';
import { taskRow, commentRow, nextTaskNumber, listProjects } from '../services/repo.js';
import { boardInsights, STATUSES } from '../services/insights.js';

const router = Router();
export { STATUSES };
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const STATUS_LABEL = { backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', review: 'In review', done: 'Done' };

const checklistItem = { type: 'object' };
const schema = {
  title: rules.string({ required: true, min: 1, max: 200 }),
  description: rules.string({ max: 10000 }),
  projectId: rules.id(),
  status: rules.enum(STATUSES, { default: 'todo' }),
  priority: rules.enum(PRIORITIES, { default: 'medium' }),
  assigneeUserId: rules.id(),
  dueDate: rules.date(),
  labels: rules.array(rules.string({ min: 1, max: 30 }), { max: 10 }),
  checklist: rules.array(checklistItem, { max: 50 }),
};

function cleanChecklist(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).map((item) => ({
    id: typeof item?.id === 'string' && item.id.length <= 40 ? item.id : uid(),
    text: String(item?.text ?? '').trim().slice(0, 300),
    done: Boolean(item?.done),
  })).filter((i) => i.text);
}

function checkRefs(companyId, body) {
  if (body.projectId && !one('SELECT id FROM projects WHERE id = ? AND company_id = ?', body.projectId, companyId)) throw new HttpError(400, 'Please fix the highlighted fields', { fields: { projectId: 'Unknown project' } });
  if (body.assigneeUserId && !one('SELECT id FROM memberships WHERE user_id = ? AND company_id = ?', body.assigneeUserId, companyId)) throw new HttpError(400, 'Please fix the highlighted fields', { fields: { assigneeUserId: 'Not a member' } });
}

const TASK_SELECT = `SELECT t.*, (SELECT count(*) FROM task_comments c WHERE c.task_id = t.id) AS comment_count,
  (SELECT co.key FROM companies co WHERE co.id = t.company_id) AS company_key FROM tasks t`;
const TASK_REF = /^[A-Za-z][A-Za-z0-9]{0,9}-(\d{1,9})$/;

// Accepts a task id (UUID) or a human reference such as ACME-12.
function loadTask(companyId, idOrRef) {
  const m = TASK_REF.exec(String(idOrRef));
  const row = m
    ? one(`${TASK_SELECT} WHERE t.number = ? AND t.company_id = ?`, Number(m[1]), companyId)
    : one(`${TASK_SELECT} WHERE t.id = ? AND t.company_id = ?`, idOrRef, companyId);
  return row ? taskRow(row) : null;
}

function taskRef(req, task) { return `${req.company.key}-${task.number}`; }

// Every status change is recorded so the flow and burnup charts have real history to draw.
function recordEvent(companyId, task, fromStatus, toStatus, at) {
  if (fromStatus === toStatus) return;
  db.prepare('INSERT INTO task_events (id, company_id, task_id, project_id, from_status, to_status, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uid(), companyId, task.id ?? task, task.projectId ?? null, fromStatus, toStatus, at);
}

function listTasks(req, q) {
  let items = all(`${TASK_SELECT} WHERE t.company_id = ? ORDER BY t.status, t.position, t.created_at`, req.company.id).map(taskRow);
  if (q.project === 'none') items = items.filter((t) => !t.projectId);
  else if (q.project) items = items.filter((t) => t.projectId === q.project);
  if (q.assignee === 'none') items = items.filter((t) => !t.assigneeUserId);
  else if (q.assignee) items = items.filter((t) => t.assigneeUserId === q.assignee);
  if (q.status) items = items.filter((t) => t.status === q.status);
  if (q.priority) items = items.filter((t) => t.priority === q.priority);
  if (q.label) items = items.filter((t) => t.labels.includes(q.label));
  if (q.q) {
    const needle = String(q.q).toLowerCase();
    items = items.filter((t) => t.title.toLowerCase().includes(needle) || (t.description || '').toLowerCase().includes(needle) || `${req.company.key}-${t.number}`.toLowerCase() === needle);
  }
  if (q.updatedSince) items = items.filter((t) => t.updatedAt > String(q.updatedSince));
  const offset = Math.max(Number(q.offset) || 0, 0);
  const limit = Number(q.limit) > 0 ? Math.min(Number(q.limit), 1000) : null;
  const total = items.length;
  if (offset || limit) items = items.slice(offset, limit ? offset + limit : undefined);
  return { items, total };
}

function requireProject(req) {
  if (!one('SELECT id FROM projects WHERE id = ? AND company_id = ?', req.params.projectId, req.company.id)) throw notFound('Project');
  return req.params.projectId;
}

router.get('/tasks', (req, res) => res.json(listTasks(req, req.query)));
router.get('/projects/:projectId/tasks', (req, res) => res.json(listTasks(req, { ...req.query, project: requireProject(req) })));

// ---------- board analytics ----------
router.get('/insights', (req, res) => res.json(boardInsights(req.company.id, { projectId: req.query.project || null, days: req.query.days })));
router.get('/projects/:projectId/insights', (req, res) => res.json(boardInsights(req.company.id, { projectId: requireProject(req), days: req.query.days })));

router.post('/tasks', (req, res) => res.status(201).json(createTask(req, req.body)));
router.post('/projects/:projectId/tasks', (req, res) => {
  const projectId = requireProject(req);
  const raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  res.status(201).json(createTask(req, { ...raw, projectId }));
});

function createTask(req, raw) {
  const body = validate(schema, raw);
  checkRefs(req.company.id, body);
  const id = uid();
  const ts = now();
  const task = tx(() => {
    const number = nextTaskNumber(db, req.company.id);
    const maxPos = one('SELECT coalesce(max(position), 0) AS m FROM tasks WHERE company_id = ? AND status = ?', req.company.id, body.status).m;
    db.prepare(`INSERT INTO tasks (id, company_id, project_id, number, title_enc, description_enc, status, priority, assignee_user_id, due_date, labels_enc, checklist_enc, position, created_by, created_at, updated_at, completed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.company.id, body.projectId ?? null, number, encrypt(body.title), encrypt(body.description ?? null), body.status, body.priority, body.assigneeUserId ?? null, body.dueDate ?? null,
        encryptJSON(body.labels ?? []), encryptJSON(cleanChecklist(body.checklist)), maxPos + 1, req.user.id, ts, ts, body.status === 'done' ? ts : null);
    const created = loadTask(req.company.id, id);
    recordEvent(req.company.id, created, null, body.status, ts);
    return created;
  });
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'created', entityType: 'task', entityId: id, summary: `${req.user.name} created task ${taskRef(req, task)} "${task.title}"` });
  return task;
}

// ---------- bulk actions on a selection ----------
const BULK_ACTIONS = ['update', 'move', 'delete', 'duplicate', 'add_label', 'remove_label'];

router.post('/tasks/bulk', (req, res) => {
  const body = validate({ ids: rules.array(rules.id(), { required: true, max: 200 }), action: rules.enum(BULK_ACTIONS, { required: true }) }, req.body);
  const ids = [...new Set(body.ids)];
  if (!ids.length) throw new HttpError(400, 'Select at least one task');
  const data = req.body.data && typeof req.body.data === 'object' && !Array.isArray(req.body.data) ? req.body.data : {};
  const placeholders = ids.map(() => '?').join(',');
  const found = new Map(all(`${TASK_SELECT} WHERE t.company_id = ? AND t.id IN (${placeholders})`, req.company.id, ...ids).map((r) => [r.id, taskRow(r)]));
  if (found.size !== ids.length) throw notFound('One or more tasks');
  const tasks = ids.map((id) => found.get(id));
  const ts = now();
  const n = tasks.length;
  const noun = `${n} task${n === 1 ? '' : 's'}`;
  const refs = tasks.map((t) => taskRef(req, t)).join(', ');
  const log = (action, summary) => logActivity({ companyId: req.company.id, userId: req.user.id, action, entityType: 'task', entityId: n === 1 ? tasks[0].id : null, summary: `${req.user.name} ${summary}`, meta: { ids, refs } });
  const reload = () => ({ items: ids.map((id) => loadTask(req.company.id, id)) });

  if (body.action === 'delete') {
    if (!hasRole(req, 'admin') && tasks.some((t) => t.createdBy !== req.user.id)) throw forbidden('You can only delete tasks you created');
    tx(() => { const del = db.prepare('DELETE FROM tasks WHERE id = ?'); for (const t of tasks) del.run(t.id); });
    log('deleted', `deleted ${noun} (${refs})`);
    return res.json({ deleted: n });
  }

  if (body.action === 'duplicate') {
    const created = tx(() => tasks.map((t) => {
      const id = uid();
      const number = nextTaskNumber(db, req.company.id);
      const maxPos = one('SELECT coalesce(max(position), 0) AS m FROM tasks WHERE company_id = ? AND status = ?', req.company.id, t.status).m;
      db.prepare(`INSERT INTO tasks (id, company_id, project_id, number, title_enc, description_enc, status, priority, assignee_user_id, due_date, labels_enc, checklist_enc, position, created_by, created_at, updated_at, completed_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, req.company.id, t.projectId, number, encrypt(`${t.title} (copy)`), encrypt(t.description ?? null), t.status, t.priority, t.assigneeUserId, t.dueDate,
          encryptJSON(t.labels), encryptJSON(t.checklist.map((c) => ({ ...c, id: uid(), done: false }))), maxPos + 1, req.user.id, ts, ts, t.status === 'done' ? ts : null);
      recordEvent(req.company.id, { id, projectId: t.projectId }, null, t.status, ts);
      return id;
    }));
    log('created', `duplicated ${noun} (${refs})`);
    return res.status(201).json({ items: created.map((id) => loadTask(req.company.id, id)) });
  }

  if (body.action === 'move') {
    const mv = validate({ status: rules.enum(STATUSES, { required: true }), index: rules.int({ required: true, min: 0, max: 100000 }) }, data);
    tx(() => {
      const moving = new Set(ids);
      const column = all('SELECT id FROM tasks WHERE company_id = ? AND status = ? ORDER BY position, created_at', req.company.id, mv.status).map((r) => r.id).filter((id) => !moving.has(id));
      column.splice(Math.min(mv.index, column.length), 0, ...ids);
      const pos = db.prepare('UPDATE tasks SET position = ? WHERE id = ?');
      column.forEach((id, i) => pos.run(i + 1, id));
      const st = db.prepare('UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?');
      for (const t of tasks) {
        st.run(mv.status, ts, mv.status === 'done' ? (t.completedAt || ts) : null, t.id);
        recordEvent(req.company.id, t, t.status, mv.status, ts);
      }
    });
    if (tasks.some((t) => t.status !== mv.status)) log('moved', `moved ${noun} to ${STATUS_LABEL[mv.status]}`);
    return res.json(reload());
  }

  if (body.action === 'add_label' || body.action === 'remove_label') {
    const { label } = validate({ label: rules.string({ required: true, min: 1, max: 30 }) }, data);
    const adding = body.action === 'add_label';
    tx(() => {
      const upd = db.prepare('UPDATE tasks SET labels_enc = ?, updated_at = ? WHERE id = ?');
      for (const t of tasks) {
        const labels = adding ? [...new Set([...t.labels, label])].slice(0, 10) : t.labels.filter((l) => l !== label);
        upd.run(encryptJSON(labels), ts, t.id);
      }
    });
    log('updated', adding ? `added the label "${label}" to ${noun}` : `removed the label "${label}" from ${noun}`);
    return res.json(reload());
  }

  // update: the same field on every selected task
  const patch = validate({ status: rules.enum(STATUSES), priority: rules.enum(PRIORITIES), assigneeUserId: rules.id(), projectId: rules.id(), dueDate: rules.date() }, data, { partial: true });
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change');
  checkRefs(req.company.id, patch);
  tx(() => {
    let nextPos = patch.status ? one('SELECT coalesce(max(position), 0) AS m FROM tasks WHERE company_id = ? AND status = ?', req.company.id, patch.status).m : 0;
    const upd = db.prepare('UPDATE tasks SET status = ?, priority = ?, assignee_user_id = ?, project_id = ?, due_date = ?, position = ?, completed_at = ?, updated_at = ? WHERE id = ?');
    for (const t of tasks) {
      const status = patch.status ?? t.status;
      let position = t.position;
      if (patch.status && patch.status !== t.status) { nextPos += 1; position = nextPos; }
      upd.run(status, patch.priority ?? t.priority, 'assigneeUserId' in patch ? patch.assigneeUserId : t.assigneeUserId, 'projectId' in patch ? patch.projectId : t.projectId,
        'dueDate' in patch ? patch.dueDate : t.dueDate, position, status === 'done' ? (t.completedAt || ts) : null, ts, t.id);
      recordEvent(req.company.id, { id: t.id, projectId: 'projectId' in patch ? patch.projectId : t.projectId }, t.status, status, ts);
    }
  });
  let summary = `updated ${noun}`;
  if (patch.status) summary = `moved ${noun} to ${STATUS_LABEL[patch.status]}`;
  else if (patch.priority) summary = `set ${noun} to ${patch.priority} priority`;
  else if ('assigneeUserId' in patch) summary = patch.assigneeUserId ? `assigned ${noun} to ${one('SELECT name FROM users WHERE id = ?', patch.assigneeUserId)?.name || 'a member'}` : `unassigned ${noun}`;
  else if ('projectId' in patch) summary = patch.projectId ? `moved ${noun} to project "${listProjects(req.company.id).find((p) => p.id === patch.projectId)?.name || ''}"` : `removed ${noun} from their project`;
  else if ('dueDate' in patch) summary = patch.dueDate ? `set the due date of ${noun} to ${patch.dueDate}` : `cleared the due date on ${noun}`;
  log(patch.status ? 'moved' : 'updated', `${summary} (${refs})`);
  res.json(reload());
});

router.get('/tasks/:id', (req, res) => {
  const task = loadTask(req.company.id, req.params.id);
  if (!task) throw notFound('Task');
  const comments = all('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC', task.id).map(commentRow);
  res.json({ ...task, comments });
});

router.patch('/tasks/:id', (req, res) => {
  const current = loadTask(req.company.id, req.params.id);
  if (!current) throw notFound('Task');
  const body = validate(schema, req.body, { partial: true });
  checkRefs(req.company.id, body);
  const next = { ...current, ...body };
  if ('checklist' in body) next.checklist = cleanChecklist(body.checklist);
  const ts = now();
  tx(() => {
    let position = current.position;
    if (body.status && body.status !== current.status) {
      position = one('SELECT coalesce(max(position), 0) AS m FROM tasks WHERE company_id = ? AND status = ?', req.company.id, body.status).m + 1;
    }
    const completedAt = next.status === 'done' ? (current.completedAt || ts) : null;
    db.prepare(`UPDATE tasks SET project_id = ?, title_enc = ?, description_enc = ?, status = ?, priority = ?, assignee_user_id = ?, due_date = ?, labels_enc = ?, checklist_enc = ?, position = ?, updated_at = ?, completed_at = ? WHERE id = ?`)
      .run(next.projectId ?? null, encrypt(next.title), encrypt(next.description ?? null), next.status, next.priority, next.assigneeUserId ?? null, next.dueDate ?? null,
        encryptJSON(next.labels ?? []), encryptJSON(next.checklist ?? []), position, ts, completedAt, current.id);
    recordEvent(req.company.id, { id: current.id, projectId: next.projectId }, current.status, next.status, ts);
  });
  const changed = Object.keys(body);
  let verb = `updated task ${taskRef(req, current)}`;
  if (changed.length === 1 && body.status) verb = `moved ${taskRef(req, current)} to ${STATUS_LABEL[body.status]}`;
  else if (changed.length === 1 && 'assigneeUserId' in body) {
    const who = body.assigneeUserId ? one('SELECT name FROM users WHERE id = ?', body.assigneeUserId)?.name : null;
    verb = who ? `assigned ${taskRef(req, current)} to ${who}` : `unassigned ${taskRef(req, current)}`;
  } else if (changed.length === 1 && 'checklist' in body) verb = `updated the checklist on ${taskRef(req, current)}`;
  logActivity({ companyId: req.company.id, userId: req.user.id, action: body.status && changed.length === 1 ? 'moved' : 'updated', entityType: 'task', entityId: current.id, summary: `${req.user.name} ${verb}`, meta: { changed } });
  res.json(loadTask(req.company.id, current.id));
});

// Move to a column at a given index; the whole target column is re-sequenced.
router.post('/tasks/:id/move', (req, res) => {
  const current = loadTask(req.company.id, req.params.id);
  if (!current) throw notFound('Task');
  const body = validate({ status: rules.enum(STATUSES, { required: true }), index: rules.int({ required: true, min: 0, max: 100000 }) }, req.body);
  const ts = now();
  tx(() => {
    const column = all('SELECT id FROM tasks WHERE company_id = ? AND status = ? AND id != ? ORDER BY position, created_at', req.company.id, body.status, current.id).map((r) => r.id);
    const idx = Math.min(body.index, column.length);
    column.splice(idx, 0, current.id);
    const upd = db.prepare('UPDATE tasks SET position = ? WHERE id = ?');
    column.forEach((id, i) => upd.run(i + 1, id));
    const completedAt = body.status === 'done' ? (current.completedAt || ts) : null;
    db.prepare('UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?').run(body.status, ts, completedAt, current.id);
    recordEvent(req.company.id, current, current.status, body.status, ts);
  });
  if (body.status !== current.status) {
    logActivity({ companyId: req.company.id, userId: req.user.id, action: 'moved', entityType: 'task', entityId: current.id, summary: `${req.user.name} moved ${taskRef(req, current)} to ${STATUS_LABEL[body.status]}` });
  }
  res.json(loadTask(req.company.id, current.id));
});

router.delete('/tasks/:id', (req, res) => {
  const current = loadTask(req.company.id, req.params.id);
  if (!current) throw notFound('Task');
  if (!hasRole(req, 'admin') && current.createdBy !== req.user.id) throw forbidden('Only the creator or an admin can delete a task');
  db.prepare('DELETE FROM tasks WHERE id = ?').run(current.id);
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'deleted', entityType: 'task', entityId: current.id, summary: `${req.user.name} deleted task ${taskRef(req, current)} "${current.title}"` });
  res.json({ ok: true });
});

// ---------- comments ----------
router.post('/tasks/:id/comments', (req, res) => {
  const task = loadTask(req.company.id, req.params.id);
  if (!task) throw notFound('Task');
  const body = validate({ body: rules.string({ required: true, min: 1, max: 5000 }) }, req.body);
  const id = uid();
  db.prepare('INSERT INTO task_comments (id, company_id, task_id, user_id, body_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.company.id, task.id, req.user.id, encrypt(body.body), now());
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'commented', entityType: 'task', entityId: task.id, summary: `${req.user.name} commented on ${taskRef(req, task)}` });
  res.status(201).json(commentRow(one('SELECT * FROM task_comments WHERE id = ?', id)));
});

router.patch('/tasks/:id/comments/:cid', (req, res) => {
  const c = one('SELECT * FROM task_comments WHERE id = ? AND task_id = ? AND company_id = ?', req.params.cid, loadTask(req.company.id, req.params.id)?.id ?? req.params.id, req.company.id);
  if (!c) throw notFound('Comment');
  if (c.user_id !== req.user.id && !hasRole(req, 'admin')) throw forbidden();
  const body = validate({ body: rules.string({ required: true, min: 1, max: 5000 }) }, req.body);
  db.prepare('UPDATE task_comments SET body_enc = ?, updated_at = ? WHERE id = ?').run(encrypt(body.body), now(), c.id);
  res.json(commentRow(one('SELECT * FROM task_comments WHERE id = ?', c.id)));
});

router.delete('/tasks/:id/comments/:cid', (req, res) => {
  const c = one('SELECT * FROM task_comments WHERE id = ? AND task_id = ? AND company_id = ?', req.params.cid, loadTask(req.company.id, req.params.id)?.id ?? req.params.id, req.company.id);
  if (!c) throw notFound('Comment');
  if (c.user_id !== req.user.id && !hasRole(req, 'admin')) throw forbidden();
  db.prepare('DELETE FROM task_comments WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

export default router;
