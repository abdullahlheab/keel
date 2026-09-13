// Central configuration. Loads .env, validates secrets, generates a key on first run.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // strip trailing inline comment (only if preceded by whitespace)
    const hash = value.search(/\s#/);
    if (hash !== -1 && !/^["']/.test(value)) value = value.slice(0, hash).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const ENV_FILE = process.env.ENV_FILE || path.join(ROOT, '.env');
loadDotEnv(ENV_FILE);

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function ensureEncryptionKey() {
  let key = process.env.ENCRYPTION_KEY;
  if (!key) {
    key = randomBytes(32).toString('base64');
    if (process.env.NODE_ENV !== 'test') {
      const line = `\n# Generated ${new Date().toISOString()} - back this up, it cannot be recovered\nENCRYPTION_KEY=${key}\n`;
      fs.appendFileSync(ENV_FILE, line, { mode: 0o600 });
      try { fs.chmodSync(ENV_FILE, 0o600); } catch { /* windows */ }
      console.warn('\n' + '='.repeat(72));
      console.warn('  No ENCRYPTION_KEY found. A new one was generated and saved to .env');
      console.warn('  BACK IT UP NOW. Without it, encrypted data cannot be read.');
      console.warn('='.repeat(72) + '\n');
    }
    process.env.ENCRYPTION_KEY = key;
  }
  const buf = Buffer.from(key, 'base64');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded (run `npm run setup`).');
  }
  return buf;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  trustProxy: bool(process.env.TRUST_PROXY, false),
  secureCookies: bool(process.env.SECURE_COOKIES, false),
  allowOpenSignup: bool(process.env.ALLOW_OPEN_SIGNUP, false),
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || './data'),
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  encryptionKey: ensureEncryptionKey(),
  sessionTtlDays: 30,
  mfaPendingTtlMinutes: 10,
  inviteTtlDays: 7,
  maxReceiptBytes: 10 * 1024 * 1024,
  loginLockoutAttempts: 10,
  loginLockoutMinutes: 15,
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
