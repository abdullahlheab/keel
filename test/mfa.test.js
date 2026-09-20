// Two-factor hardening: a code works once, and a pending sign-in gets a limited number of tries.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client } from './helpers.js';

const PW = 'long-enough-password-1';
let srv;
// Imported only after bootServer has set the environment: server/config.js reads it once, on first import.
let totpCode;
before(async () => {
  srv = await bootServer({ ALLOW_OPEN_SIGNUP: 'true' });
  ({ totpCode } = await import('../server/crypto.js'));
});
after(async () => { await srv.close(); });

// Registers an account with two-factor already switched on.
async function accountWith2fa(email) {
  const c = client(srv.base);
  const reg = await c.post('/api/auth/register', { name: 'Person', email, password: PW, companyName: 'Co' });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  const setup = await c.post('/api/auth/me/mfa/setup', { password: PW });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const enable = await c.post('/api/auth/me/mfa/enable', { code: totpCode(setup.data.secret) });
  assert.equal(enable.status, 200, JSON.stringify(enable.data));
  return { c, secret: setup.data.secret, recoveryCodes: enable.data.recoveryCodes };
}

async function signInTo2faPrompt(c, email) {
  await c.post('/api/auth/logout');
  c.clearCookie();
  const login = await c.post('/api/auth/login', { email, password: PW });
  assert.equal(login.data.mfaRequired, true, 'expected a two-factor challenge');
}

test('a TOTP code that has been accepted cannot be used a second time', async () => {
  const email = 'once@x.com';
  const { c, secret, recoveryCodes } = await accountWith2fa(email);

  await signInTo2faPrompt(c, email);
  const code = totpCode(secret);
  const first = await c.post('/api/auth/mfa', { code });
  assert.equal(first.status, 200, JSON.stringify(first.data));

  // Same code, still inside its 30-second window, on a fresh sign-in.
  await signInTo2faPrompt(c, email);
  const replay = await c.post('/api/auth/mfa', { code });
  assert.equal(replay.status, 401, 'a spent code must not sign anyone in again');

  // The account is not stuck: a recovery code still finishes the sign-in.
  const rec = await c.post('/api/auth/mfa', { code: recoveryCodes[0] });
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
});

test('wrong codes are capped and the pending sign-in is thrown away', async () => {
  const email = 'capped@x.com';
  const { c, secret } = await accountWith2fa(email);
  await signInTo2faPrompt(c, email);

  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await c.post('/api/auth/mfa', { code: '000000' })).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401]);

  // The half-finished session is gone, so even the correct code is no longer accepted on it.
  const afterCap = await c.post('/api/auth/mfa', { code: totpCode(secret) });
  assert.equal(afterCap.status, 401, 'the pending session should have been destroyed');

  // Starting over from the sign-in page still works.
  await signInTo2faPrompt(c, email);
  const ok = await c.post('/api/auth/mfa', { code: totpCode(secret) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await c.get('/api/auth/me')).status, 200);
});

test('recovery codes are also covered by the attempt cap', async () => {
  const email = 'recovery@x.com';
  const { c } = await accountWith2fa(email);
  await signInTo2faPrompt(c, email);

  // Guessing recovery codes burns the same allowance as guessing TOTP codes.
  for (let i = 0; i < 4; i++) {
    const r = await c.post('/api/auth/mfa', { code: `abcde-${i}0000` });
    assert.equal(r.status, 401);
  }
  const last = await c.post('/api/auth/mfa', { code: 'abcde-99999' });
  assert.equal(last.status, 401);
  const dead = await c.get('/api/auth/me');
  assert.equal(dead.status, 401, 'the session should be gone, not merely pending');
});
