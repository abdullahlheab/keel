// API-key authentication for /api/v1. Cookies are never consulted here, so there is no CSRF surface.
import { db, now, one } from '../db.js';
import { sha256 } from '../crypto.js';
import { HttpError } from './errors.js';
import { rateLimit } from './security.js';

export const KEY_PREFIX = 'keel_';
const TEST = process.env.NODE_ENV === 'test';

function extractKey(req) {
  const header = req.get('Authorization') || '';
  if (/^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim();
  return String(req.get('X-API-Key') || '').trim();
}

export function requireApiKey(req, res, next) {
  const token = extractKey(req);
  const deny = (message) => {
    res.setHeader('WWW-Authenticate', 'Bearer realm="Keel API"');
    next(new HttpError(401, message, { docs: '/developers' }));
  };
  if (!token) return deny('Missing API key. Send the header "Authorization: Bearer <your key>".');
  if (!token.startsWith(KEY_PREFIX)) return deny('That does not look like a Keel API key.');

  const key = one('SELECT * FROM api_keys WHERE key_hash = ?', sha256(token));
  if (!key || key.revoked_at) return deny('Invalid or revoked API key.');
  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) return deny('This API key has expired.');

  const user = one('SELECT * FROM users WHERE id = ?', key.user_id);
  const membership = user && one('SELECT * FROM memberships WHERE user_id = ? AND company_id = ?', key.user_id, key.company_id);
  const company = membership && one('SELECT * FROM companies WHERE id = ?', key.company_id);
  if (!user || !membership || !company) return deny('The person who created this key no longer has access to the company.');

  if (key.scope === 'read' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next(new HttpError(403, 'This API key is read-only. Create a read & write key to make changes.'));
  }

  db.prepare('UPDATE api_keys SET last_used_at = ?, last_used_ip = ?, request_count = request_count + 1 WHERE id = ?').run(now(), req.ip || null, key.id);

  req.apiKey = key;
  req.session = null;
  // The key acts as the person who created it, with their role. The name marks API activity in the audit log.
  req.user = { ...user, name: `${user.name} (API: ${key.name})` };
  req.company = company;
  req.membership = membership;
  req.role = membership.role;
  next();
}

export const apiKeyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: TEST ? 100000 : 300,
  key: (req) => `key:${req.apiKey?.id || req.ip}`,
  message: 'Rate limit exceeded for this API key (300 requests per minute).',
});
