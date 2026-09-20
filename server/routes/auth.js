// Accounts: register, login (+ optional TOTP), sessions, profile, invites.
import { Router } from 'express';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { db, tx, now, one, all } from '../db.js';
import {
  uid, hashPassword, verifyPassword, randomToken, sha256, encrypt, decrypt,
  generateTotpSecret, verifyTotp, verifyTotpCounter, otpauthUrl, generateRecoveryCodes, safeEqual,
} from '../crypto.js';
import { validate, rules } from '../validate.js';
import { HttpError, notFound, unauthorized } from '../middleware/errors.js';
import {
  createSession, destroySession, clearSessionCookie, setSessionCookie,
  requireAuth, requireMfaPending, loadSession,
} from '../middleware/auth.js';
import { authLimiter, emailLimiter, mfaLimiter } from '../middleware/security.js';
import { logActivity } from '../services/activity.js';
import { publicUser, companyRow } from '../services/repo.js';

const router = Router();

// Fixed hash used to equalise timing when the email is unknown.
const DUMMY_HASH = await hashPassword('dummy-password-for-timing');

const AVATAR_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const pickColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

const DEFAULT_CATEGORIES = [
  ['Software & subscriptions', '#2a78d6'], ['Cloud & hosting', '#4a3aa7'], ['Marketing', '#eb6834'],
  ['Legal & accounting', '#1baf7a'], ['Equipment', '#eda100'], ['Travel', '#e87ba4'],
  ['Contractors', '#008300'], ['Office', '#898781'], ['Meals', '#e34948'], ['Other', '#52514e'],
];

export function makeCompanyKey(name) {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  let key = words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] || 'CO');
  key = key.toUpperCase().slice(0, 4);
  return key.length >= 2 ? key : (key + 'CO').slice(0, 2);
}

const DEFAULT_PROJECT_CATEGORIES = [
  ['Client work', '#2a78d6'], ['Internal', '#4a3aa7'], ['Product', '#1baf7a'], ['Research', '#eda100'], ['Operations', '#898781'],
];

function seedCategories(companyId) {
  const stmt = db.prepare('INSERT INTO categories (id, company_id, name, color, sort_order) VALUES (?, ?, ?, ?, ?)');
  DEFAULT_CATEGORIES.forEach(([name, color], i) => stmt.run(uid(), companyId, name, color, i));
  const proj = db.prepare('INSERT INTO project_categories (id, company_id, name, color, sort_order) VALUES (?, ?, ?, ?, ?)');
  DEFAULT_PROJECT_CATEGORIES.forEach(([name, color], i) => proj.run(uid(), companyId, name, color, i));
}

function mePayload(user) {
  const memberships = all(`SELECT c.*, m.role FROM memberships m JOIN companies c ON c.id = m.company_id
                           WHERE m.user_id = ? ORDER BY m.created_at ASC`, user.id);
  return {
    user: { ...publicUser(user), totpEnabled: Boolean(user.totp_enabled), createdAt: user.created_at },
    companies: memberships.map((c) => ({ ...companyRow(c), role: c.role })),
  };
}

const passwordRule = rules.string({ required: true, min: 10, max: 200, trim: false });

// Tells the login page whether anyone can still self-register.
router.get('/policy', (req, res) => {
  const users = one('SELECT count(*) AS c FROM users').c;
  res.json({ openSignup: users === 0 || config.allowOpenSignup, firstRun: users === 0 });
});

// ---------- registration ----------
router.post('/register', authLimiter, async (req, res) => {
  const userCount = one('SELECT count(*) AS c FROM users').c;
  if (userCount > 0 && !config.allowOpenSignup) {
    throw new HttpError(403, 'Sign-up is invite-only. Ask a teammate for an invite link.');
  }
  const body = validate({
    name: rules.string({ required: true, min: 1, max: 80 }),
    email: rules.email({ required: true }),
    password: passwordRule,
    companyName: rules.string({ required: true, min: 1, max: 80 }),
    currency: rules.string({ pattern: /^[A-Z]{3}$/, default: 'USD', message: 'Use a 3-letter code like USD' }),
  }, req.body);
  if (body.password.toLowerCase().includes(body.email.split('@')[0].toLowerCase()) && body.email.split('@')[0].length > 3) {
    throw new HttpError(400, 'Please fix the highlighted fields', { fields: { password: 'Password must not contain your email' } });
  }
  if (one('SELECT id FROM users WHERE email = ?', body.email)) {
    throw new HttpError(409, 'An account with that email already exists');
  }
  const passwordHash = await hashPassword(body.password);
  const ts = now();
  const userId = uid();
  const companyId = uid();
  tx(() => {
    db.prepare('INSERT INTO users (id, email, name, password_hash, avatar_color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, body.email, body.name, passwordHash, pickColor(), ts, ts);
    db.prepare('INSERT INTO companies (id, name, key, currency, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(companyId, body.companyName, makeCompanyKey(body.companyName), body.currency || 'USD', userId, ts, ts);
    db.prepare('INSERT INTO memberships (id, company_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(uid(), companyId, userId, 'owner', ts);
    db.prepare('INSERT INTO company_counters (company_id, task_seq) VALUES (?, 0)').run(companyId);
    seedCategories(companyId);
    logActivity({ companyId, userId, action: 'created', entityType: 'company', entityId: companyId, summary: `${body.name} created the company ${body.companyName}` });
  });
  createSession(req, res, userId);
  const user = one('SELECT * FROM users WHERE id = ?', userId);
  res.status(201).json(mePayload(user));
});

// ---------- login ----------
router.post('/login', authLimiter, emailLimiter, async (req, res) => {
  const body = validate({ email: rules.email({ required: true }), password: rules.string({ required: true, max: 200, trim: false }) }, req.body);
  const user = one('SELECT * FROM users WHERE email = ?', body.email);
  if (!user) {
    await verifyPassword(body.password, DUMMY_HASH);
    throw unauthorized('Incorrect email or password');
  }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
    throw new HttpError(429, `Account temporarily locked after too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
  const ok = await verifyPassword(body.password, user.password_hash);
  if (!ok) {
    const failed = user.failed_logins + 1;
    const lock = failed >= config.loginLockoutAttempts ? new Date(Date.now() + config.loginLockoutMinutes * 60000).toISOString() : null;
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : failed, lock, user.id);
    throw unauthorized('Incorrect email or password');
  }
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
  if (user.totp_enabled) {
    createSession(req, res, user.id, { mfaPending: true });
    return res.json({ mfaRequired: true });
  }
  createSession(req, res, user.id);
  res.json(mePayload(user));
});

// ---------- second factor ----------
// A half-finished sign-in gets a few tries, then the pending session is thrown away. Without this,
// the code space is small enough to walk through once the password is known.
const MFA_MAX_ATTEMPTS = 5;

router.post('/mfa', authLimiter, requireMfaPending, mfaLimiter, (req, res) => {
  const body = validate({ code: rules.string({ required: true, max: 20 }) }, req.body);
  const user = req.user;
  const secret = decrypt(user.totp_secret_enc);
  // Anything at or below the last counter we accepted is a replay, even though it is still in the window.
  const counter = verifyTotpCounter(secret, body.code, { after: user.totp_last_counter });
  let ok = counter !== null;
  if (ok) {
    db.prepare('UPDATE users SET totp_last_counter = ? WHERE id = ?').run(counter, user.id);
  } else {
    // recovery code?
    const codes = JSON.parse(user.recovery_codes || '[]');
    const hash = sha256(body.code.toLowerCase().replace(/\s+/g, ''));
    const idx = codes.findIndex((c) => safeEqual(c, hash));
    if (idx !== -1) {
      codes.splice(idx, 1);
      db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(codes), user.id);
      ok = true;
    }
  }
  if (!ok) {
    const attempts = (req.session.mfa_attempts || 0) + 1;
    if (attempts >= MFA_MAX_ATTEMPTS) {
      destroySession(req.session.id);
      clearSessionCookie(req, res);
      // Deliberately the same wording whether the code was wrong, reused, or the tries ran out.
      throw unauthorized('That code is not valid. Sign in again to retry.');
    }
    db.prepare('UPDATE sessions SET mfa_attempts = ? WHERE id = ?').run(attempts, req.session.id);
    throw unauthorized('That code is not valid');
  }
  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000;
  db.prepare('UPDATE sessions SET mfa_pending = 0, mfa_attempts = 0, expires_at = ?, last_seen_at = ? WHERE id = ?')
    .run(new Date(Date.now() + ttlMs).toISOString(), now(), req.session.id);
  setSessionCookie(req, res, req.sessionToken, Math.floor(ttlMs / 1000));
  res.json(mePayload(user));
});

router.post('/logout', (req, res) => {
  if (req.session) destroySession(req.session.id);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// ---------- profile ----------
router.get('/me', requireAuth, (req, res) => res.json(mePayload(req.user)));

router.patch('/me', requireAuth, (req, res) => {
  const body = validate({ name: rules.string({ min: 1, max: 80 }), avatarColor: rules.color() }, req.body, { partial: true });
  if (body.name) db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').run(body.name, now(), req.user.id);
  if (body.avatarColor) db.prepare('UPDATE users SET avatar_color = ?, updated_at = ? WHERE id = ?').run(body.avatarColor, now(), req.user.id);
  res.json(mePayload(one('SELECT * FROM users WHERE id = ?', req.user.id)));
});

router.post('/me/password', requireAuth, authLimiter, async (req, res) => {
  const body = validate({ currentPassword: rules.string({ required: true, max: 200, trim: false }), newPassword: passwordRule }, req.body);
  if (!(await verifyPassword(body.currentPassword, req.user.password_hash))) throw new HttpError(400, 'Please fix the highlighted fields', { fields: { currentPassword: 'Incorrect password' } });
  const hash = await hashPassword(body.newPassword);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now(), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.session.id);
  // API keys outlive sessions, so signing the other devices out is not enough on its own.
  const revoked = revokeKeysOf(req.user, 'the password was changed');
  res.json({ ok: true, revokedKeys: revoked });
});

// Revokes every live API key belonging to a user, and notes it in each affected company's log.
export function revokeKeysOf(user, reason) {
  const live = all('SELECT id, name, company_id FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', user.id);
  if (!live.length) return 0;
  db.prepare('UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), user.id);
  for (const companyId of new Set(live.map((k) => k.company_id))) {
    const names = live.filter((k) => k.company_id === companyId).map((k) => `"${k.name}"`).join(', ');
    logActivity({
      companyId,
      userId: user.id,
      action: 'deleted',
      entityType: 'apikey',
      entityId: null,
      summary: `${user.name} revoked ${names} because ${reason}`,
    });
  }
  return live.length;
}

router.get('/me/sessions', requireAuth, (req, res) => {
  const rows = all('SELECT id, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND mfa_pending = 0 ORDER BY last_seen_at DESC', req.user.id);
  res.json({ items: rows.map((s) => ({ id: s.id, ip: s.ip, userAgent: s.user_agent, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at, current: s.id === req.session.id })) });
});

router.delete('/me/sessions/:id', requireAuth, (req, res) => {
  const s = one('SELECT id FROM sessions WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!s) throw notFound('Session');
  destroySession(s.id);
  if (s.id === req.session.id) clearSessionCookie(req, res);
  res.json({ ok: true });
});

router.post('/me/sessions/revoke-others', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.session.id);
  res.json({ ok: true, revoked: r.changes });
});

// ---------- two-factor ----------
router.post('/me/mfa/setup', requireAuth, authLimiter, async (req, res) => {
  const body = validate({ password: rules.string({ required: true, max: 200, trim: false }) }, req.body);
  if (!(await verifyPassword(body.password, req.user.password_hash))) throw new HttpError(400, 'Please fix the highlighted fields', { fields: { password: 'Incorrect password' } });
  if (req.user.totp_enabled) throw new HttpError(409, 'Two-factor authentication is already enabled');
  const secret = generateTotpSecret();
  db.prepare('UPDATE users SET totp_secret_enc = ? WHERE id = ?').run(encrypt(secret), req.user.id);
  const url = otpauthUrl('Keel', req.user.email, secret);
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
  res.json({ secret, otpauthUrl: url, qrDataUrl });
});

router.post('/me/mfa/enable', requireAuth, authLimiter, (req, res) => {
  const body = validate({ code: rules.string({ required: true, max: 10 }) }, req.body);
  if (!req.user.totp_secret_enc) throw new HttpError(400, 'Start setup first');
  if (!verifyTotp(decrypt(req.user.totp_secret_enc), body.code)) throw new HttpError(400, 'Please fix the highlighted fields', { fields: { code: 'That code is not valid. Check the time on your phone.' } });
  const codes = generateRecoveryCodes();
  db.prepare('UPDATE users SET totp_enabled = 1, recovery_codes = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(codes.map((c) => sha256(c))), now(), req.user.id);
  res.json({ ok: true, recoveryCodes: codes });
});

router.post('/me/mfa/disable', requireAuth, authLimiter, async (req, res) => {
  const body = validate({ password: rules.string({ required: true, max: 200, trim: false }), code: rules.string({ required: true, max: 20 }) }, req.body);
  if (!(await verifyPassword(body.password, req.user.password_hash))) throw new HttpError(400, 'Please fix the highlighted fields', { fields: { password: 'Incorrect password' } });
  if (!req.user.totp_enabled || !verifyTotp(decrypt(req.user.totp_secret_enc), body.code)) throw new HttpError(400, 'Please fix the highlighted fields', { fields: { code: 'That code is not valid' } });
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, recovery_codes = NULL, updated_at = ? WHERE id = ?').run(now(), req.user.id);
  res.json({ ok: true });
});

// ---------- invites (public lookup + accept) ----------
function findInvite(token) {
  return one(`SELECT i.*, c.name AS company_name, u.name AS inviter_name FROM invites i
              JOIN companies c ON c.id = i.company_id JOIN users u ON u.id = i.created_by
              WHERE i.token_hash = ?`, sha256(token));
}

function inviteState(inv) {
  if (inv.revoked_at) return 'revoked';
  if (inv.accepted_at) return 'accepted';
  if (new Date(inv.expires_at).getTime() < Date.now()) return 'expired';
  return 'valid';
}

router.get('/invites/:token', authLimiter, (req, res) => {
  const inv = findInvite(req.params.token);
  if (!inv) throw notFound('Invite');
  res.json({
    companyName: inv.company_name, inviterName: inv.inviter_name, role: inv.role, email: inv.email,
    state: inviteState(inv), signedIn: Boolean(req.user && !req.session?.mfa_pending),
    signedInEmail: req.user?.email || null,
  });
});

router.post('/invites/:token/accept', authLimiter, async (req, res) => {
  const inv = findInvite(req.params.token);
  if (!inv) throw notFound('Invite');
  if (inviteState(inv) !== 'valid') throw new HttpError(410, `This invite is ${inviteState(inv)}`);
  const ts = now();
  let user = req.user && !req.session?.mfa_pending ? req.user : null;

  if (!user) {
    const body = validate({
      name: rules.string({ required: true, min: 1, max: 80 }),
      email: rules.email({ required: true }),
      password: passwordRule,
    }, req.body);
    if (inv.email && inv.email !== body.email) throw new HttpError(400, 'Please fix the highlighted fields', { fields: { email: `This invite was sent to ${inv.email}` } });
    if (one('SELECT id FROM users WHERE email = ?', body.email)) throw new HttpError(409, 'An account with that email already exists. Sign in first, then open the invite link again.');
    const hash = await hashPassword(body.password);
    const userId = uid();
    db.prepare('INSERT INTO users (id, email, name, password_hash, avatar_color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, body.email, body.name, hash, pickColor(), ts, ts);
    user = one('SELECT * FROM users WHERE id = ?', userId);
  } else if (inv.email && inv.email !== user.email) {
    throw new HttpError(403, `This invite was sent to ${inv.email}, but you are signed in as ${user.email}`);
  }

  if (one('SELECT id FROM memberships WHERE company_id = ? AND user_id = ?', inv.company_id, user.id)) {
    throw new HttpError(409, 'You are already a member of this company');
  }
  tx(() => {
    db.prepare('INSERT INTO memberships (id, company_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)').run(uid(), inv.company_id, user.id, inv.role, ts);
    db.prepare('UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?').run(ts, user.id, inv.id);
    logActivity({ companyId: inv.company_id, userId: user.id, action: 'joined', entityType: 'member', entityId: user.id, summary: `${user.name} joined as ${inv.role}` });
  });
  if (!req.user) createSession(req, res, user.id);
  res.json({ ...mePayload(user), companyId: inv.company_id });
});

export default router;
