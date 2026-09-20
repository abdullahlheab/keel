import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, client } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'keel.js');
let srv; let secret; let configDir;

function run(args, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, KEEL_API_KEY: '', KEEL_URL: '', KEEL_CONFIG_DIR: configDir, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

before(async () => {
  srv = await bootServer({ ALLOW_OPEN_SIGNUP: 'true' });
  const owner = client(srv.base);
  await owner.post('/api/auth/register', { name: 'Cleo', email: 'cleo@x.com', password: 'first-long-password', companyName: 'Cli Co' });
  secret = (await owner.post('/api/keys', { name: 'Assistant', scope: 'write', password: 'first-long-password' })).data.secret;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-cli-'));
  fs.writeFileSync(path.join(configDir, 'credentials.json'), JSON.stringify({ url: srv.base, key: secret }));
});
after(async () => { await srv.close(); });

test('reads the key from the credentials file and never prints it', async () => {
  const who = await run(['whoami']);
  assert.equal(who.code, 0, who.stderr);
  assert.match(who.stdout, /"Assistant" \(read & write\) acting as Cleo, owner of Cli Co/);
  const created = await run(['post', 'tasks', JSON.stringify({ title: 'Made from the CLI', priority: 'high' })]);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).ref, 'CC-1');
  const piped = await run(['post', 'tasks'], { input: JSON.stringify({ title: 'Piped in' }) });
  assert.equal(JSON.parse(piped.stdout).ref, 'CC-2');
  const patched = await run(['patch', 'tasks/CC-1', '{"status":"done"}']);
  assert.equal(JSON.parse(patched.stdout).status, 'done');
  const listed = await run(['get', '/api/v1/tasks?status=done']);
  assert.deepEqual(JSON.parse(listed.stdout).items.map((t) => t.ref), ['CC-1']);
  const mangled = await run(['get', 'C:/Program Files/Git/tasks/CC-2']);
  assert.equal(JSON.parse(mangled.stdout).title, 'Piped in', 'paths rewritten by Git Bash still work');
  for (const r of [who, created, piped, patched, listed, mangled]) assert.ok(!(r.stdout + r.stderr).includes(secret), 'the key never appears in output');
});

test('errors are clear, exit non-zero, and still hide the key', async () => {
  const missing = await run(['get', 'tasks/CC-999']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /HTTP 404/);
  const badJson = await run(['post', 'tasks', '{not json']);
  assert.notEqual(badJson.code, 0);
  assert.match(badJson.stderr, /not valid JSON/);
  const wrongKey = await run(['whoami'], { env: { KEEL_API_KEY: `${secret}x` } });
  assert.notEqual(wrongKey.code, 0);
  assert.ok(!(wrongKey.stdout + wrongKey.stderr).includes(secret));
  const down = await run(['whoami'], { env: { KEEL_URL: 'http://127.0.0.1:59321' } });
  assert.match(down.stderr, /Could not reach/);
});

test('login input handling: bare domains, messy pastes, and a hidden key prompt', async () => {
  const { normalizeUrl, extractKey, promptLogin } = await import('../scripts/keel.js');
  assert.equal(normalizeUrl('keel.example.com'), 'https://keel.example.com');
  assert.equal(normalizeUrl(' https://keel.example.com/api/v1/ '), 'https://keel.example.com');
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeUrl('127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(normalizeUrl('', 'http://127.0.0.1:3000'), 'http://127.0.0.1:3000');

  const key = 'keel_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xyz';
  assert.equal(extractKey(key), key);
  assert.equal(extractKey(`  "${key}"  `), key);
  assert.equal(extractKey(`Bearer ${key}`), key);
  assert.equal(extractKey(`[200~${key}[201~`), key, 'bracketed paste markers are ignored');
  assert.equal(extractKey(`﻿${key}\r`), key);
  assert.equal(extractKey('keel_short'), null);
  assert.equal(extractKey('sk-something-else-entirely-0000000000'), null);
  assert.equal(extractKey(''), null);

  // Both answers typed with Windows line endings, the way a real terminal delivers them.
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough(); const output = new PassThrough();
  let shown = ''; output.on('data', (d) => { shown += d; });
  const pending = promptLogin(input, output, 'http://127.0.0.1:3000');
  input.write('keel.example.com\r\n');
  await new Promise((r) => setTimeout(r, 50));
  input.write(`${key}\r\n`);
  const answer = await pending;
  assert.equal(answer.url, 'https://keel.example.com');
  assert.equal(extractKey(answer.raw), key);
  assert.ok(!shown.includes(key), 'the key is never echoed to the terminal');
  assert.match(shown, /API key \(input is hidden/);
});

test('login refuses to run without a real terminal, and logout forgets the key', async () => {
  const login = await run(['login'], { input: `${secret}\n` });
  assert.notEqual(login.code, 0);
  assert.match(login.stderr, /yourself in a terminal/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-cli-empty-'));
  const none = await run(['get', 'tasks'], { env: { KEEL_CONFIG_DIR: empty } });
  assert.match(none.stderr, /No API key saved yet/);
  const out = await run(['logout']);
  assert.equal(out.code, 0);
  assert.ok(!fs.existsSync(path.join(configDir, 'credentials.json')));
});

test('the key is sealed on disk, and a plaintext file is resealed on first use', async (t) => {
  if (process.platform !== 'win32') return t.skip('DPAPI sealing is Windows only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-seal-'));
  const file = path.join(dir, 'credentials.json');
  fs.writeFileSync(file, JSON.stringify({ url: srv.base, key: secret }));
  assert.match(fs.readFileSync(file, 'utf8'), /keel_/, 'the fixture starts out in plain text');

  const first = await run(['whoami'], { env: { KEEL_CONFIG_DIR: dir } });
  assert.equal(first.code, 0, first.stderr);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.protection, 'dpapi-currentuser');
  assert.ok(!('key' in saved), 'the plaintext field is gone');
  assert.ok(saved.keyProtected, 'a sealed blob took its place');
  assert.ok(!/keel_[A-Za-z0-9_-]{20,}/.test(fs.readFileSync(file, 'utf8')), 'no key is left on disk');
  assert.match(first.stdout, /sealed with DPAPI/);

  const again = await run(['whoami'], { env: { KEEL_CONFIG_DIR: dir } });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /Assistant/, 'the sealed key still opens on the next run');
  assert.ok(!/keel_[A-Za-z0-9_-]{20,}/.test(again.stdout + again.stderr), 'and is never printed');
});

test('a sealed key from another account is refused with a clear message', async (t) => {
  if (process.platform !== 'win32') return t.skip('DPAPI sealing is Windows only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-foreign-'));
  // A blob this account cannot open: valid base64, but not a DPAPI blob of ours.
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ url: srv.base, protection: 'dpapi-currentuser', keyProtected: Buffer.from('not a real dpapi blob').toString('base64') }));
  const res = await run(['whoami'], { env: { KEEL_CONFIG_DIR: dir } });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /could not be unsealed|login/i);
});
