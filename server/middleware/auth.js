// Session cookies, current user/company resolution, and role checks.
import { config } from '../config.js';
import { db, now, one } from '../db.js';
import { uid, randomToken, sha256 } from '../crypto.js';
import { HttpError, unauthorized, forbidden } from './errors.js';

export const COOKIE = 'ct_session';
export const ROLE_RANK = { member: 1, admin: 2, owner: 3 };

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) { return Boolean(req.secure || config.secureCookies); }

export function setSessionCookie(req, res, token, maxAgeSeconds) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req, res) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

// Creates a session row and sets the cookie. Returns the session id.
export function createSession(req, res, userId, { mfaPending = false } = {}) {
  const token = randomToken(32);
  const ttlMs = mfaPending
    ? config.mfaPendingTtlMinutes * 60 * 1000
    : config.sessionTtlDays * 24 * 60 * 60 * 1000;
  const ts = now();
  const id = uid();
  db.prepare(`INSERT INTO sessions (id, user_id, token_hash, mfa_pending, ip, user_agent, created_at, last_seen_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, sha256(token), mfaPending ? 1 : 0, req.ip || null, String(req.get('User-Agent') || '').slice(0, 300), ts, ts, new Date(Date.now() + ttlMs).toISOString());
  setSessionCookie(req, res, token, Math.floor(ttlMs / 1000));
  return id;
}

export function destroySession(sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// Attaches req.session / req.user when a valid cookie is present. Never throws.
export function loadSession(req, res, next) {
  req.user = null;
  req.session = null;
  const token = parseCookies(req.get('Cookie'))[COOKIE];
  if (!token) return next();
  const session = one('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
  if (!session) { clearSessionCookie(req, res); return next(); }
  if (new Date(session.expires_at).getTime() < Date.now()) {
    destroySession(session.id);
    clearSessionCookie(req, res);
    return next();
  }
  const user = one('SELECT * FROM users WHERE id = ?', session.user_id);
  if (!user) { destroySession(session.id); clearSessionCookie(req, res); return next(); }

  // Sliding expiry: refresh at most once an hour for full sessions.
  if (!session.mfa_pending) {
    const lastSeen = new Date(session.last_seen_at).getTime();
    if (Date.now() - lastSeen > 60 * 60 * 1000) {
      const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000;
      db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = ? WHERE id = ?')
        .run(now(), new Date(Date.now() + ttlMs).toISOString(), req.ip || null, session.id);
      setSessionCookie(req, res, token, Math.floor(ttlMs / 1000));
    }
  }
  req.session = session;
  req.sessionToken = token;
  req.user = user;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.session.mfa_pending) return next(new HttpError(401, 'Two-factor code required', { mfaRequired: true }));
  next();
}

// Requires a signed-in user with mfa still pending (only the /auth/mfa route).
export function requireMfaPending(req, res, next) {
  if (!req.user || !req.session?.mfa_pending) return next(unauthorized('No pending sign-in'));
  next();
}

// Resolves the active company from X-Company-Id (or the user's first membership).
export function requireCompany(req, res, next) {
  const requested = req.get('X-Company-Id');
  let membership;
  if (requested) {
    membership = one('SELECT * FROM memberships WHERE user_id = ? AND company_id = ?', req.user.id, requested);
    if (!membership) return next(forbidden('You are not a member of that company'));
  } else {
    membership = one('SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at ASC LIMIT 1', req.user.id);
    if (!membership) return next(new HttpError(409, 'You are not part of a company yet', { noCompany: true }));
  }
  const company = one('SELECT * FROM companies WHERE id = ?', membership.company_id);
  if (!company) return next(forbidden());
  req.company = company;
  req.membership = membership;
  req.role = membership.role;
  next();
}

export function requireRole(minRole) {
  return (req, res, next) => {
    if (ROLE_RANK[req.role] >= ROLE_RANK[minRole]) return next();
    next(forbidden(`This action requires the ${minRole} role`));
  };
}

export function hasRole(req, minRole) { return ROLE_RANK[req.role] >= ROLE_RANK[minRole]; }
