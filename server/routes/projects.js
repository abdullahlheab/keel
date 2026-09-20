// Projects: CRUD plus per-project spend and task progress.
import { Router } from 'express';
import { db, now, one, all } from '../db.js';
import { uid, encrypt, encryptInt } from '../crypto.js';
import { validate, rules } from '../validate.js';
import { notFound } from '../middleware/errors.js';
import { requireRole } from '../middleware/auth.js';
import { logActivity } from '../services/activity.js';
import { projectRow, listProjects, projectStats, expenseRow, taskRow, monthKey } from '../services/repo.js';

const router = Router();
const STATUSES = ['planning', 'active', 'on_hold', 'completed', 'archived'];

const schema = {
  name: rules.string({ required: true, min: 1, max: 120 }),
  description: rules.string({ max: 5000 }),
  status: rules.enum(STATUSES, { default: 'active' }),
  color: rules.color({ default: '#2a78d6' }),
  budget: rules.money({ min: 0 }),
  startDate: rules.date(),
  endDate: rules.date(),
  leadUserId: rules.id(),
};

function withStats(project, stats) {
  const s = stats.get(project.id) || { spentCents: 0, expenseCount: 0, taskTotal: 0, taskDone: 0, taskOpen: 0 };
  return { ...project, ...s };
}

function assertMember(companyId, userId) {
  if (!userId) return null;
  return one('SELECT user_id FROM memberships WHERE company_id = ? AND user_id = ?', companyId, userId) ? userId : null;
}

router.get('/projects', (req, res) => {
  const stats = projectStats(req.company.id);
  let items = listProjects(req.company.id).map((p) => withStats(p, stats));
  if (req.query.status) items = items.filter((p) => p.status === req.query.status);
  else if (req.query.includeArchived !== '1') items = items.filter((p) => p.status !== 'archived');
  res.json({ items });
});

router.post('/projects', (req, res) => {
  const body = validate(schema, req.body);
  const id = uid();
  const ts = now();
  db.prepare(`INSERT INTO projects (id, company_id, name_enc, description_enc, status, color, budget_cents_enc, start_date, end_date, lead_user_id, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.company.id, encrypt(body.name), encrypt(body.description ?? null), body.status, body.color, encryptInt(body.budget ?? null),
      body.startDate ?? null, body.endDate ?? null, assertMember(req.company.id, body.leadUserId), req.user.id, ts, ts);
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'created', entityType: 'project', entityId: id, summary: `${req.user.name} created project "${body.name}"` });
  res.status(201).json(withStats(projectRow(one('SELECT * FROM projects WHERE id = ?', id)), projectStats(req.company.id)));
});

router.get('/projects/:id', (req, res) => {
  const row = one('SELECT * FROM projects WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!row) throw notFound('Project');
  const project = withStats(projectRow(row), projectStats(req.company.id));
  const expenses = all('SELECT * FROM expenses WHERE project_id = ? ORDER BY date DESC, created_at DESC', row.id).map(expenseRow);
  const tasks = all(`SELECT t.*, (SELECT count(*) FROM task_comments c WHERE c.task_id = t.id) AS comment_count, ? AS company_key
                     FROM tasks t WHERE t.project_id = ? ORDER BY t.status, t.position`, req.company.key, row.id).map(taskRow);
  const byMonth = {};
  const byCategory = {};
  for (const e of expenses) {
    byMonth[monthKey(e.date)] = (byMonth[monthKey(e.date)] || 0) + (e.amountCents || 0);
    const k = e.categoryId || 'none';
    byCategory[k] = (byCategory[k] || 0) + (e.amountCents || 0);
  }
  res.json({
    project,
    expenses: expenses.slice(0, 50),
    tasks,
    spendByMonth: Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([month, cents]) => ({ month, cents })),
    spendByCategory: Object.entries(byCategory).map(([categoryId, cents]) => ({ categoryId: categoryId === 'none' ? null : categoryId, cents })).sort((a, b) => b.cents - a.cents),
  });
});

router.patch('/projects/:id', (req, res) => {
  const row = one('SELECT * FROM projects WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!row) throw notFound('Project');
  const body = validate(schema, req.body, { partial: true });
  const current = projectRow(row);
  const next = { ...current, ...body };
  if ('budget' in body) next.budgetCents = body.budget;
  if ('leadUserId' in body) next.leadUserId = assertMember(req.company.id, body.leadUserId);
  db.prepare(`UPDATE projects SET name_enc = ?, description_enc = ?, status = ?, color = ?, budget_cents_enc = ?, start_date = ?, end_date = ?, lead_user_id = ?, updated_at = ? WHERE id = ?`)
    .run(encrypt(next.name), encrypt(next.description ?? null), next.status, next.color, encryptInt(next.budgetCents ?? null), next.startDate ?? null, next.endDate ?? null, next.leadUserId ?? null, now(), row.id);
  const changed = Object.keys(body);
  const verb = body.status && changed.length === 1 ? `marked project "${next.name}" as ${body.status.replace('_', ' ')}` : `updated project "${next.name}"`;
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'updated', entityType: 'project', entityId: row.id, summary: `${req.user.name} ${verb}`, meta: { changed } });
  res.json(withStats(projectRow(one('SELECT * FROM projects WHERE id = ?', row.id)), projectStats(req.company.id)));
});

router.delete('/projects/:id', requireRole('admin'), (req, res) => {
  const row = one('SELECT * FROM projects WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!row) throw notFound('Project');
  const name = projectRow(row).name;
  db.prepare('DELETE FROM projects WHERE id = ?').run(row.id); // expenses/tasks keep their rows, project_id becomes NULL
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'deleted', entityType: 'project', entityId: row.id, summary: `${req.user.name} deleted project "${name}"` });
  res.json({ ok: true });
});

export default router;
