// Company activity feed (audit trail).
import { Router } from 'express';
import { all } from '../db.js';
import { activityRow } from '../services/activity.js';

const router = Router();

router.get('/activity', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const params = [req.company.id];
  let where = 'a.company_id = ?';
  if (req.query.before) { where += ' AND a.created_at < ?'; params.push(String(req.query.before)); }
  if (req.query.entityType) { where += ' AND a.entity_type = ?'; params.push(String(req.query.entityType)); }
  if (req.query.entityId) { where += ' AND a.entity_id = ?'; params.push(String(req.query.entityId)); }
  if (req.query.userId) { where += ' AND a.user_id = ?'; params.push(String(req.query.userId)); }
  const rows = all(`SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
                    WHERE ${where} ORDER BY a.created_at DESC LIMIT ?`, ...params, limit + 1);
  const items = rows.slice(0, limit).map(activityRow);
  res.json({ items, hasMore: rows.length > limit, nextBefore: items.length ? items[items.length - 1].createdAt : null });
});

export default router;
