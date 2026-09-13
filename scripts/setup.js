// Generates a .env with a fresh encryption key (never overwrites an existing key).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

if (fs.existsSync(envFile) && /^ENCRYPTION_KEY=\S+/m.test(fs.readFileSync(envFile, 'utf8'))) {
  console.log('.env already has an ENCRYPTION_KEY - nothing to do.');
  console.log('Back that key up somewhere safe (a password manager). Without it your data is unreadable.');
  process.exit(0);
}

const key = randomBytes(32).toString('base64');
const content = example.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${key}`);
fs.writeFileSync(envFile, content, { mode: 0o600 });
console.log('Created .env with a new ENCRYPTION_KEY.');
console.log('');
console.log('  IMPORTANT: back up this key now. If you lose it, encrypted data cannot be recovered.');
console.log(`  ${key}`);
console.log('');
console.log('Next: npm start  (then open http://localhost:3000 and create the first account)');
