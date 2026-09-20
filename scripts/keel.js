#!/usr/bin/env node
// Keel command-line client.
// The API key is kept in ~/.keel/credentials.json (your user profile, outside any repo), so it never has to be
// pasted into a chat, a script, or a command line. Nothing in this tool ever prints the key.
//
//   node scripts/keel.js login                          save a key (prompts; input is hidden)
//   node scripts/keel.js whoami                         show which key is saved and what it can do
//   node scripts/keel.js get tasks?status=todo
//   node scripts/keel.js post tasks '{"title":"Call the bank","priority":"high"}'
//   node scripts/keel.js patch tasks/ACME-12 '{"status":"done"}'
//   node scripts/keel.js delete tasks/ACME-12
//   node scripts/keel.js post projects/<id>/tasks @task.json      body from a file, or pipe JSON on stdin
//   node scripts/keel.js logout                         forget the saved key
//
// KEEL_URL and KEEL_API_KEY environment variables override the saved values.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const CONFIG_DIR = process.env.KEEL_CONFIG_DIR || path.join(os.homedir(), '.keel');
const CONFIG_FILE = path.join(CONFIG_DIR, 'credentials.json');
const DEFAULT_URL = 'http://127.0.0.1:3000';
const METHODS = new Set(['get', 'post', 'patch', 'delete']);

function readConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* not logged in */ }
  return {
    url: (process.env.KEEL_URL || saved.url || DEFAULT_URL).replace(/\/+$/, ''),
    key: process.env.KEEL_API_KEY || saved.key || null,
    source: process.env.KEEL_API_KEY ? 'the KEEL_API_KEY environment variable' : CONFIG_FILE,
  };
}

// Belt and braces: even an unexpected error message can never carry the key to the screen.
function redact(text, key) {
  let out = String(text);
  if (key) out = out.split(key).join('keel_<hidden>');
  return out.replace(/keel_[A-Za-z0-9_-]{20,}/g, 'keel_<hidden>');
}

// Errors are thrown rather than calling process.exit(): exiting right after a network request crashes Node on Windows.
class CliError extends Error {
  constructor(message, exitCode) { super(message); this.exitCode = exitCode; }
}
function fail(message, key, code = 1) {
  throw new CliError(redact(message, key), code);
}

async function call(config, method, apiPath, body) {
  const res = await fetch(`${config.url}/api/v1/${apiPath}`, {
    method: method.toUpperCase(),
    headers: { Authorization: `Bearer ${config.key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Git Bash on Windows rewrites arguments that start with "/" into Windows paths; undo that and accept both forms.
function cleanPath(raw) {
  let p = String(raw || '').replace(/^[A-Za-z]:[\\/].*?[\\/]Git[\\/]/, '').replace(/\\/g, '/');
  p = p.replace(/^\/+/, '').replace(/^api\/v1\//, '');
  return p;
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (str) => { if (str.includes(question)) rl.output.write(question); else if (str.includes('\n') || str.includes('\r')) rl.output.write('\n'); };
    }
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function readBody(arg) {
  let text = null;
  if (arg && arg.startsWith('@')) text = fs.readFileSync(arg.slice(1), 'utf8');
  else if (arg) text = arg;
  else if (!process.stdin.isTTY) { const chunks = []; for await (const c of process.stdin) chunks.push(c); text = Buffer.concat(chunks).toString('utf8').trim() || null; }
  if (text === null) return undefined;
  try { return JSON.parse(text); } catch { throw new Error('The request body is not valid JSON.'); }
}

function describe(me) {
  return `"${me.key.name}" (${me.key.scope === 'write' ? 'read & write' : 'read only'}) acting as ${me.actingAs.name}, ${me.actingAs.role} of ${me.company.name}${me.key.expiresAt ? `, expires ${me.key.expiresAt.slice(0, 10)}` : ''}`;
}

async function login() {
  if (!process.stdin.isTTY) fail('Run "login" yourself in a terminal window: it asks for the key with hidden input, so the key never passes through anything else.');
  const current = readConfig();
  const url = ((await ask(`Keel URL [${current.url}]: `)) || current.url).replace(/\/+$/, '');
  const key = await ask('API key (input is hidden, paste and press Enter): ', { hidden: true });
  if (!key.startsWith('keel_')) fail('That does not look like a Keel API key (it should start with keel_). Nothing was saved.');
  let res;
  try { res = await call({ url, key }, 'get', 'me'); } catch (err) { if (err instanceof CliError) throw err; fail(`Could not reach ${url}. Is Keel running? (${err.cause?.code || err.message})`, key); }
  if (!res.ok) fail(`The server rejected that key: ${res.data?.error || res.status}. Nothing was saved.`, key);
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ url, key, savedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Saved to ${CONFIG_FILE}`);
  console.log(`Key ${describe(res.data)}.`);
  console.log('To stop access at any time, revoke the key in Keel under API, or run: node scripts/keel.js logout');
}

async function main() {
  const [command, target, bodyArg] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  if (command === 'login') return login();
  if (command === 'logout') {
    fs.rmSync(CONFIG_FILE, { force: true });
    console.log('Saved key removed from this computer. Revoke it in Keel under API if it should stop working everywhere.');
    return;
  }
  const config = readConfig();
  if (!config.key) fail('No API key saved yet. Run this yourself in a terminal: node scripts/keel.js login');
  try {
    if (command === 'whoami') {
      const res = await call(config, 'get', 'me');
      if (!res.ok) fail(`${res.status}: ${res.data?.error || 'request failed'}`, config.key);
      console.log(`Key ${describe(res.data)}.`);
      console.log(`Server ${config.url} · key read from ${config.source}`);
      return;
    }
    if (!METHODS.has(command.toLowerCase())) fail(`Unknown command "${command}". Try: login, whoami, get, post, patch, delete, logout.`);
    if (!target) fail(`Usage: node scripts/keel.js ${command} <path> [json | @file.json]`);
    const body = ['post', 'patch'].includes(command.toLowerCase()) ? await readBody(bodyArg) : undefined;
    const res = await call(config, command, cleanPath(target), body);
    const out = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
    if (!res.ok) fail(`HTTP ${res.status}\n${out}`, config.key, 2);
    console.log(redact(out, config.key));
  } catch (err) {
    if (err instanceof CliError) throw err;
    fail(err.message === 'fetch failed' ? `Could not reach ${config.url}. Is Keel running? (${err.cause?.code || err.cause?.message || 'no connection'})` : err.message, config.key);
  }
}

main().catch((err) => {
  process.stderr.write(`${redact(err.message)}\n`);
  process.exitCode = err.exitCode || 1;
});
