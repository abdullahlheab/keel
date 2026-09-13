// All cryptographic primitives in one place.
//  - AES-256-GCM field/file encryption (random 96-bit IV, 128-bit tag, versioned)
//  - scrypt password hashing (Node built-in, constant-time verify)
//  - random tokens + SHA-256 for storing session / invite tokens
//  - TOTP (RFC 6238) for optional two-factor auth
import {
  randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash, createHmac,
  scrypt as scryptCb, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scrypt = promisify(scryptCb);
const KEY = config.encryptionKey;
const VERSION = 'v1';

// ---------- field encryption ----------
export function encrypt(plain, aad = '') {
  if (plain === null || plain === undefined) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return VERSION + '.' + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decrypt(stored, aad = '') {
  if (stored === null || stored === undefined) return null;
  const dot = stored.indexOf('.');
  if (dot === -1) throw new Error('Malformed ciphertext');
  const version = stored.slice(0, dot);
  if (version !== VERSION) throw new Error('Unsupported ciphertext version ' + version);
  const buf = Buffer.from(stored.slice(dot + 1), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function encryptJSON(value) {
  if (value === null || value === undefined) return null;
  return encrypt(JSON.stringify(value));
}
export function decryptJSON(stored, fallback = null) {
  if (stored === null || stored === undefined) return fallback;
  try { return JSON.parse(decrypt(stored)); } catch { return fallback; }
}

// Integers (money in cents) are stored as encrypted decimal strings.
export function encryptInt(n) {
  if (n === null || n === undefined) return null;
  return encrypt(String(Math.trunc(n)));
}
export function decryptInt(stored) {
  if (stored === null || stored === undefined) return null;
  const n = Number(decrypt(stored));
  return Number.isFinite(n) ? n : null;
}

// ---------- file encryption (receipts) ----------
export function encryptBuffer(buf) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}
export function decryptBuffer(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ---------- passwords ----------
const SCRYPT = { logN: 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(32);
  const N = 2 ** SCRYPT.logN;
  const hash = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, { N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.logN, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, logN, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const N = 2 ** Number(logN);
    const actual = await scrypt(password.normalize('NFKC'), salt, expected.length, { N, r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------- tokens ----------
export const uid = () => randomUUID();
export function randomToken(bytes = 32) { return randomBytes(bytes).toString('base64url'); }
export function sha256(input) { return createHash('sha256').update(input).digest('hex'); }
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------- TOTP ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value * 256) + byte; bits += 8;
    while (bits >= 5) { out += B32[Math.floor(value / 2 ** (bits - 5)) % 32]; bits -= 5; value = value % 2 ** bits; }
  }
  if (bits > 0) out += B32[(value * 2 ** (5 - bits)) % 32];
  return out;
}
export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value * 32) + B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push(Math.floor(value / 2 ** (bits - 8)) % 256); bits -= 8; value = value % 2 ** bits; }
  }
  return Buffer.from(out);
}
export function generateTotpSecret() { return base32Encode(randomBytes(20)); }

export function totpCode(secretB32, timeMs = Date.now(), step = 30, digits = 6) {
  const counter = Math.floor(timeMs / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) * 2 ** 24) + (hmac[offset + 1] * 2 ** 16) + (hmac[offset + 2] * 2 ** 8) + hmac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function verifyTotp(secretB32, code, window = 1) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const now = Date.now();
  for (let w = -window; w <= window; w++) {
    if (safeEqual(totpCode(secretB32, now + w * 30_000), clean)) return true;
  }
  return false;
}

export function otpauthUrl(issuer, account, secret) {
  const label = encodeURIComponent(issuer + ':' + account);
  return 'otpauth://totp/' + label + '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=30';
}

export function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString('hex'); // 10 hex chars
    codes.push(raw.slice(0, 5) + '-' + raw.slice(5));
  }
  return codes;
}
