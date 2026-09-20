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
  secret = (await owner.post('/api/keys', { name: 'Assistant', scope: 'write' })).data.secret;
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
