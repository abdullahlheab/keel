// Admin recovery: reset a user's password from the server's terminal.
//   npm run reset-password -- you@company.com                 (prompts for the new password)
//   npm run reset-password -- you@company.com --disable-2fa   (also removes two-factor, e.g. lost phone)
//   npm run reset-password -- you@company.com --password "temporary pass"   (non-interactive)
// Every session for that user is signed out and any lockout is cleared.
import readline from 'node:readline';
import { db, now, one } from '../server/db.js';
import { hashPassword } from '../server/crypto.js';

const args = process.argv.slice(2);
const email = (args.find((a) => !a.startsWith('--')) || '').trim().toLowerCase();
const disable2fa = args.includes('--disable-2fa');
const pwIndex = args.indexOf('--password');
let password = pwIndex !== -1 ? args[pwIndex + 1] : null;

if (!email) {
  console.error('Usage: npm run reset-password -- <email> [--disable-2fa] [--password <new password>]');
  process.exit(1);
}
const user = one('SELECT id, name, email, totp_enabled FROM users WHERE email = ?', email);
if (!user) {
  console.error(`No account with email ${email}. Accounts on this server:`);
  for (const u of db.prepare('SELECT email FROM users ORDER BY created_at').all()) console.error(`  ${u.email}`);
  process.exit(1);
}

function ask(question, { masked = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (masked) {
      rl._writeToOutput = function write(str) { if (str.includes(question)) rl.output.write(question); else if (str.includes('\n')) rl.output.write('\n'); };
    }
    rl.question(question, (answer) => { rl.close(); if (masked) process.stdout.write('\n'); resolve(answer); });
  });
}

if (!password) {
  if (!process.stdin.isTTY) { console.error('No terminal available for a prompt; pass --password instead.'); process.exit(1); }
  password = await ask(`New password for ${user.name} <${user.email}>: `, { masked: true });
  const again = await ask('Type it again: ', { masked: true });
  if (password !== again) { console.error('Passwords do not match.'); process.exit(1); }
}
if (password.length < 10) { console.error('Password must be at least 10 characters.'); process.exit(1); }

const hash = await hashPassword(password);
db.exec('BEGIN');
try {
  db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(hash, now(), user.id);
  if (disable2fa) db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, recovery_codes = NULL WHERE id = ?').run(user.id);
  const sessions = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id).changes;
  db.exec('COMMIT');
  console.log(`Password updated for ${user.email}. ${sessions} session(s) signed out.${disable2fa ? ' Two-factor disabled.' : user.totp_enabled ? ' Two-factor is still enabled.' : ''}`);
  console.log('Sign in with the new password, then change it under Settings > Security if it was a temporary one.');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
} finally {
  db.close();
}
