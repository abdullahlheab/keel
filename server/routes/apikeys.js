// Managing API keys from the signed-in app (session auth only, never reachable with an API key).
import { Router } from 'express';
import { db, now, one, all } from '../db.js';
import { uid, randomToken, sha256 } from '../crypto.js';
import { validate, rules } from '../validate.js';
import { HttpError, notFound, forbidden } from '../middleware/errors.js';
import { hasRole } from '../middleware/auth.js';
import { KEY_PREFIX } from '../middleware/apikey.js';
import { logActivity } from '../services/activity.js';

const router = Router();
const MAX_ACTIVE_KEYS = 50;

function keyRow(k) {
  const expired = Boolean(k.expires_at && new Date(k.expires_at).getTime() < Date.now());
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scope: k.scope,
    userId: k.user_id,
    userName: k.user_name || null,
    createdAt: k.created_at,
    expiresAt: k.expires_at,
    revokedAt: k.revoked_at,
    lastUsedAt: k.last_used_at,
    lastUsedIp: k.last_used_ip,
    requestCount: k.request_count,
    state: k.revoked_at ? 'revoked' : expired ? 'expired' : 'active',
  };
}

router.get('/keys', (req, res) => {
  const rows = all(`SELECT k.*, u.name AS user_name FROM api_keys k LEFT JOIN users u ON u.id = k.user_id
                    WHERE k.company_id = ? ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC LIMIT 200`, req.company.id);
  const visible = hasRole(req, 'admin') ? rows : rows.filter((k) => k.user_id === req.user.id);
  res.json({ items: visible.map(keyRow), canSeeAll: hasRole(req, 'admin') });
});

router.post('/keys', (req, res) => {
  const body = validate({
    name: rules.string({ required: true, min: 1, max: 60 }),
    scope: rules.enum(['read', 'write'], { default: 'write' }),
    expiresInDays: rules.int({ min: 1, max: 3650 }),
  }, req.body);
  const active = one("SELECT count(*) AS c FROM api_keys WHERE company_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)", req.company.id, now()).c;
  if (active >= MAX_ACTIVE_KEYS) throw new HttpError(409, `A company can have at most ${MAX_ACTIVE_KEYS} active API keys. Revoke one first.`);

  const secret = KEY_PREFIX + randomToken(32);
  const id = uid();
  const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400000).toISOString() : null;
  db.prepare('INSERT INTO api_keys (id, company_id, user_id, name, prefix, key_hash, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.company.id, req.user.id, body.name, secret.slice(0, KEY_PREFIX.length + 6), sha256(secret), body.scope, expiresAt, now());
  logActivity({ companyId: req.company.id, userId: req.user.id, action: 'created', entityType: 'apikey', entityId: id, summary: `${req.user.name} created the ${body.scope === 'read' ? 'read-only' : 'read & write'} API key "${body.name}"` });
  const row = one('SELECT k.*, u.name AS user_name FROM api_keys k LEFT JOIN users u ON u.id = k.user_id WHERE k.id = ?', id);
  // The secret is returned exactly once; only its hash is stored.
  res.status(201).json({ key: keyRow(row), secret });
});

router.delete('/keys/:id', (req, res) => {
  const key = one('SELECT * FROM api_keys WHERE id = ? AND company_id = ?', req.params.id, req.company.id);
  if (!key) throw notFound('API key');
  if (key.user_id !== req.user.id && !hasRole(req, 'admin')) throw forbidden('You can only revoke keys you created');
  if (!key.revoked_at) {
    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now(), key.id);
    logActivity({ companyId: req.company.id, userId: req.user.id, action: 'deleted', entityType: 'apikey', entityId: key.id, summary: `${req.user.name} revoked the API key "${key.name}"` });
  }
  res.json({ ok: true });
});

export default router;
