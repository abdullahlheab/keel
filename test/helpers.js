// Boots the app on a random port with an isolated temp data directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function bootServer(env = {}) {
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-test-'));
  process.env.ENV_FILE = path.join(process.env.DATA_DIR, '.env');
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const { createApp } = await import('../server/app.js');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, dataDir: process.env.DATA_DIR, close: () => new Promise((r) => server.close(r)) };
}

// Minimal HTTP client with a cookie jar and the CSRF header.
export function client(base) {
  let cookie = null;
  let companyId = null;
  async function request(method, url, body, opts = {}) {
    const headers = { 'X-Requested-With': 'fetch', ...(opts.headers || {}) };
    if (!opts.noCsrf) headers['X-Requested-With'] = 'fetch'; else delete headers['X-Requested-With'];
    if (cookie) headers.Cookie = cookie;
    if (companyId) headers['X-Company-Id'] = companyId;
    let payload;
    if (body instanceof Uint8Array) { payload = body; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [pair] = sc.split(';');
      const [name, value] = pair.split('=');
      if (name === 'ct_session') cookie = value ? `ct_session=${value}` : null;
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : (opts.raw ? Buffer.from(await res.arrayBuffer()) : await res.text());
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (url, opts) => request('GET', url, undefined, opts),
    post: (url, body, opts) => request('POST', url, body, opts),
    patch: (url, body, opts) => request('PATCH', url, body, opts),
    del: (url, opts) => request('DELETE', url, undefined, opts),
    setCompany: (id) => { companyId = id; },
    clearCookie: () => { cookie = null; },
    get cookie() { return cookie; },
  };
}
