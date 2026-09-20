// Company settings, members, invites, expense categories.
import { Router } from 'express';
import { config } from '../config.js';
import { db, tx, now, one, all } from '../db.js';
import { uid, randomToken, sha256 } from '../crypto.js';
import { validate, rules } from '../validate.js';
import { HttpError, notFound, forbidden } from '../middleware/errors.js';
import { requireRole, ROLE_RANK } from '../middleware/auth.js';
import { logActivity } from '../services/activity.js';
import { companyRow, categoryRow, getMembers } from '../services/repo.js';

// Two routers, composed into one for the app.
//   workspaceRoutes - company settings and expense categories. Safe to expose to API keys.
//   identityRoutes  - members and invites. Deliberately NOT exposed on /api/v1: an invite link
//                     grants a human permanent access and outlives the key that created it, so
//                     changing who belongs to the company stays behind a signed-in session.
const router = Router();
export const workspaceRoutes = Router();
const identityRoutes = Router();
const ROLES = ['owner', 'admin', 'member'];

workspaceRoutes.get('/company', (req, res) => {
  const counts = {
    projects: one('SELECT count(*) AS c FROM projects WHERE company_id = ? AND status != ?', req.company.id, 'archived').c,
    expenses: one('SELECT count(*) AS c FROM expenses WHERE company_id = ?', req.company.id).c,
    openTasks: one('SELECT count(*) AS c FROM tasks WHERE company_id = ? AND status != ?', req.company.id, 'done').c,
  };
  res.json({
    company: companyRow(req.company),
    role: req.role,
    members: getMembers(req.company.id),
    categories: all('SELECT * FROM categories WHERE company_id = ? ORDER BY archived, sort_order, name', req.company.id).map(categoryRow),
    projectCategories: all('SELECT * FROM project_categories WHERE company_id = ? ORDER BY archived, sort_order, name', req.company.id).map(categoryRow),
    counts,
  });
});

workspaceRoutes.patch('/company', requireRole('admin'), (req, res) => {
  const body = validate({
    name: rules.string({ min: 1, max: 80 }),
    key: rules.string({ pattern: /^[A-Z][A-Z0-9]{1,5}$/, message: '2-6 uppercase letters or digits, starting with a letter' }),
    currency: rules.string({ pattern: /^[A-Z]{3}$/, message: 'Use a 3-letter code like USD' }),
  }, req.body, { partial: true });
  const c = req.company;
  db.prepare('UPDATE companies SET name = ?, key = ?, currency = ?, updated_at = ? WHERE id = ?')
    .run(body.name ?? c.name, body.key ?? c.key, body.currency ?? c.currency, now(), c.id);
  logActivity({ companyId: c.id, userId: req.user.id, action: 'updated', entityType: 'company', entityId: c.id, summary: `${req.user.name} updated company settings`, meta: body });
  res.json({ company: companyRow(one('SELECT * FROM companies WHERE id = ?', c.id)) });
});

// ---------- members ----------
identityRoutes.get('/company/members', (req, res) => res.json({ items: getMembers(req.company.id) }));

identityRoutes.patch('/company/members/:userId', requireRole('admin'), (req, res) => {
  const body = validate({ role: rules.enum(ROLES, { required: true }) }, req.body);
  const target = one('SELECT * FROM memberships WHERE company_id = ? AND user_id = ?', req.company.id, req.params.userId);
  if (!target) throw notFound('Member');
  if ((target.role === 'owner' || body.role === 'owner') && req.role !== 'owner') throw forbidden('Only an owner can change owner roles');
  if (target.role === 'owner' && body.role !== 'owner') {
    const owners = one('SELECT count(*) AS c FROM memberships WHERE company_id = ? AND role = ?', req.company.id, 'owner').c;
    if (owners <= 1) throw new HttpError(409, 'A company needs at least one owner');
  }
  db.prepare('UPDATE memberships SET role = ? WHERE id = ?').run(body.role, target.id);
  const who = one('SELECT name FROM users WHERE id = ?', target.user_id);
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'updated', entityType: 'member', entityId: target.user_id, summary: `${req.user.name} changed ${who?.name || 'a member'} to ${body.role}` });
  res.json({ items: getMembers(req.company.id) });
});

identityRoutes.delete('/company/members/:userId', (req, res) => {
  const target = one('SELECT * FROM memberships WHERE company_id = ? AND user_id = ?', req.company.id, req.params.userId);
  if (!target) throw notFound('Member');
  const isSelf = target.user_id === req.user.id;
  if (!isSelf) {
    if (ROLE_RANK[req.role] < ROLE_RANK.admin) throw forbidden();
    if (ROLE_RANK[target.role] >= ROLE_RANK[req.role]) throw forbidden('You can only remove members below your role');
  }
  if (target.role === 'owner') {
    const owners = one('SELECT count(*) AS c FROM memberships WHERE company_id = ? AND role = ?', req.company.id, 'owner').c;
    if (owners <= 1) throw new HttpError(409, 'Transfer ownership to someone else before leaving');
  }
  const who = one('SELECT name FROM users WHERE id = ?', target.user_id);
  db.prepare('DELETE FROM memberships WHERE id = ?').run(target.id);
  logActivity({ companyId: req.company.id, userId: req.user.id, action: isSelf ? 'left' : 'removed', entityType: 'member', entityId: target.user_id, summary: isSelf ? `${req.user.name} left the company` : `${req.user.name} removed ${who?.name || 'a member'}` });
  res.json({ ok: true, left: isSelf });
});

// ---------- invites ----------
function inviteRow(i) {
  return {
    id: i.id, email: i.email, role: i.role, createdBy: i.created_by, createdByName: i.creator_name || null,
    createdAt: i.created_at, expiresAt: i.expires_at, acceptedAt: i.accepted_at, revokedAt: i.revoked_at,
    state: i.revoked_at ? 'revoked' : i.accepted_at ? 'accepted' : new Date(i.expires_at).getTime() < Date.now() ? 'expired' : 'pending',
  };
}

identityRoutes.get('/company/invites', requireRole('admin'), (req, res) => {
  const rows = all(`SELECT i.*, u.name AS creator_name FROM invites i LEFT JOIN users u ON u.id = i.created_by
                    WHERE i.company_id = ? ORDER BY i.created_at DESC LIMIT 100`, req.company.id);
  res.json({ items: rows.map(inviteRow) });
});

identityRoutes.post('/company/invites', requireRole('admin'), (req, res) => {
  const body = validate({ email: rules.email(), role: rules.enum(ROLES, { default: 'member' }) }, req.body);
  if (body.role === 'owner' && req.role !== 'owner') throw forbidden('Only an owner can invite another owner');
  if (body.email && one('SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? AND u.email = ?', req.company.id, body.email)) {
    throw new HttpError(409, 'That person is already a member');
  }
  const token = randomToken(32);
  const id = uid();
  const ts = now();
  const expires = new Date(Date.now() + config.inviteTtlDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO invites (id, company_id, email, role, token_hash, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.company.id, body.email || null, body.role, sha256(token), req.user.id, expires, ts);
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'invited', entityType: 'member', entityId: null, summary: `${req.user.name} invited ${body.email || 'someone'} as ${body.role}` });
  const base = config.appUrl || `${req.protocol}://${req.get('host')}`;
  res.status(201).json({ invite: inviteRow(one('SELECT * FROM invites WHERE id = ?', id)), url: `${base}/invite/${token}` });
});

identityRoutes.delete('/company/invites/:id', requireRole('admin'), (req, res) => {
  const inv = one('SELECT * FROM invites WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!inv) throw notFound('Invite');
  db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ?').run(now(), inv.id);
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'revoked', entityType: 'member', entityId: null, summary: `${req.user.name} revoked the invite for ${inv.email || 'anyone with the link'}` });
  res.json({ ok: true });
});

// ---------- categories ----------
workspaceRoutes.get('/company/categories', (req, res) => {
  res.json({ items: all('SELECT * FROM categories WHERE company_id = ? ORDER BY archived, sort_order, name', req.company.id).map(categoryRow) });
});

workspaceRoutes.post('/company/categories', requireRole('admin'), (req, res) => {
  const body = validate({ name: rules.string({ required: true, min: 1, max: 40 }), color: rules.color({ default: '#898781' }) }, req.body);
  if (one('SELECT id FROM categories WHERE company_id = ? AND name = ? COLLATE NOCASE', req.company.id, body.name)) throw new HttpError(409, 'A category with that name already exists');
  const maxSort = one('SELECT coalesce(max(sort_order), -1) AS m FROM categories WHERE company_id = ?', req.company.id).m;
  const id = uid();
  db.prepare('INSERT INTO categories (id, company_id, name, color, sort_order) VALUES (?, ?, ?, ?, ?)').run(id, req.company.id, body.name, body.color, maxSort + 1);
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'created', entityType: 'category', entityId: id, summary: `${req.user.name} added the expense category "${body.name}"` });
  res.status(201).json(categoryRow(one('SELECT * FROM categories WHERE id = ?', id)));
});

workspaceRoutes.patch('/company/categories/:id', requireRole('admin'), (req, res) => {
  const cat = one('SELECT * FROM categories WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!cat) throw notFound('Category');
  const body = validate({ name: rules.string({ min: 1, max: 40 }), color: rules.color(), archived: rules.bool(), sortOrder: rules.int({ min: 0, max: 1000 }) }, req.body, { partial: true });
  db.prepare('UPDATE categories SET name = ?, color = ?, archived = ?, sort_order = ? WHERE id = ?')
    .run(body.name ?? cat.name, body.color ?? cat.color, body.archived === undefined ? cat.archived : (body.archived ? 1 : 0), body.sortOrder ?? cat.sort_order, cat.id);
  const what = body.archived === true ? `archived the expense category "${cat.name}"` : body.archived === false ? `restored the expense category "${cat.name}"` : `renamed the expense category "${cat.name}" to "${body.name ?? cat.name}"`;
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'updated', entityType: 'category', entityId: cat.id, summary: `${req.user.name} ${what}` });
  res.json(categoryRow(one('SELECT * FROM categories WHERE id = ?', cat.id)));
});

workspaceRoutes.delete('/company/categories/:id', requireRole('admin'), (req, res) => {
  const cat = one('SELECT * FROM categories WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!cat) throw notFound('Category');
  const used = one('SELECT count(*) AS c FROM expenses WHERE category_id = ?', cat.id).c;
  tx(() => {
    db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  });
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'deleted', entityType: 'category', entityId: cat.id, summary: `${req.user.name} deleted the expense category "${cat.name}"${used ? `, leaving ${used} expense${used === 1 ? '' : 's'} uncategorised` : ''}` });
  res.json({ ok: true, detachedExpenses: used });
});

// ---------- project categories ----------
// Kept apart from expense categories so the same word can mean different things in each.
workspaceRoutes.get('/company/project-categories', (req, res) => {
  res.json({ items: all('SELECT * FROM project_categories WHERE company_id = ? ORDER BY archived, sort_order, name', req.company.id).map(categoryRow) });
});

workspaceRoutes.post('/company/project-categories', requireRole('admin'), (req, res) => {
  const body = validate({ name: rules.string({ required: true, min: 1, max: 40 }), color: rules.color({ default: '#898781' }) }, req.body);
  if (one('SELECT id FROM project_categories WHERE company_id = ? AND name = ? COLLATE NOCASE', req.company.id, body.name)) throw new HttpError(409, 'A project category with that name already exists');
  const maxSort = one('SELECT coalesce(max(sort_order), -1) AS m FROM project_categories WHERE company_id = ?', req.company.id).m;
  const id = uid();
  db.prepare('INSERT INTO project_categories (id, company_id, name, color, sort_order) VALUES (?, ?, ?, ?, ?)').run(id, req.company.id, body.name, body.color, maxSort + 1);
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'created', entityType: 'category', entityId: id, summary: `${req.user.name} added the project category "${body.name}"` });
  res.status(201).json(categoryRow(one('SELECT * FROM project_categories WHERE id = ?', id)));
});

workspaceRoutes.patch('/company/project-categories/:id', requireRole('admin'), (req, res) => {
  const cat = one('SELECT * FROM project_categories WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!cat) throw notFound('Project category');
  const body = validate({ name: rules.string({ min: 1, max: 40 }), color: rules.color(), archived: rules.bool(), sortOrder: rules.int({ min: 0, max: 1000 }) }, req.body, { partial: true });
  db.prepare('UPDATE project_categories SET name = ?, color = ?, archived = ?, sort_order = ? WHERE id = ?')
    .run(body.name ?? cat.name, body.color ?? cat.color, body.archived === undefined ? cat.archived : (body.archived ? 1 : 0), body.sortOrder ?? cat.sort_order, cat.id);
  const what = body.archived === true ? `archived the project category "${cat.name}"` : body.archived === false ? `restored the project category "${cat.name}"` : `renamed the project category "${cat.name}" to "${body.name ?? cat.name}"`;
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'updated', entityType: 'category', entityId: cat.id, summary: `${req.user.name} ${what}` });
  res.json(categoryRow(one('SELECT * FROM project_categories WHERE id = ?', cat.id)));
});

workspaceRoutes.delete('/company/project-categories/:id', requireRole('admin'), (req, res) => {
  const cat = one('SELECT * FROM project_categories WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!cat) throw notFound('Project category');
  const used = one('SELECT count(*) AS c FROM projects WHERE category_id = ?', cat.id).c;
  db.prepare('DELETE FROM project_categories WHERE id = ?').run(cat.id);
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'deleted', entityType: 'category', entityId: cat.id, summary: `${req.user.name} deleted the project category "${cat.name}"${used ? `, leaving ${used} project${used === 1 ? '' : 's'} uncategorised` : ''}` });
  res.json({ ok: true, detachedProjects: used });
});

router.use(workspaceRoutes);
router.use(identityRoutes);

export default router;
