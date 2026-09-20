// Guards the project's central rule: anything the app can do to company data, a script can do
// through /api/v1, and the OpenAPI document tells the truth about what is there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client } from './helpers.js';

let srv; let owner; let appRouter; let v1Router; let spec;

// Express route paths and OpenAPI paths name their parameters differently
// (/projects/:projectId/tasks vs /projects/{id}/tasks), so compare the shape.
const shape = (p) => p.replace(/:[A-Za-z0-9_]+/g, '{}').replace(/\{[A-Za-z0-9_]+\}/g, '{}').replace(/(.)\/$/, '$1');
const key = (method, path) => `${method.toUpperCase()} ${shape(path)}`;

function collect(router, found = new Set()) {
  for (const layer of router?.stack || []) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        if (method !== '_all') found.add(key(method, layer.route.path));
      }
    } else if (layer.handle?.stack) {
      collect(layer.handle, found);
    }
  }
  return found;
}

// Endpoints that exist for the app but are deliberately kept away from API keys. Both are about
// identity rather than company data. Adding to this list is a security decision, not a chore.
const IDENTITY_ONLY = [
  'GET /company/members', 'PATCH /company/members/{}', 'DELETE /company/members/{}',
  'GET /company/invites', 'POST /company/invites', 'DELETE /company/invites/{}',
  'GET /keys', 'POST /keys', 'DELETE /keys/{}',
];
// Meta endpoints that describe the API rather than being part of it.
const UNDOCUMENTED_OK = ['GET /', 'GET /openapi.json'];

before(async () => {
  srv = await bootServer({ ALLOW_OPEN_SIGNUP: 'true' });
  owner = client(srv.base);
  await owner.post('/api/auth/register', { name: 'Ida', email: 'ida@x.com', password: 'first-long-password', companyName: 'Parity Co' });
  const [appRoutes, v1Routes] = await Promise.all([
    import('../server/routes/company.js'),
    import('../server/routes/v1.js'),
  ]);
  appRouter = appRoutes.default;
  v1Router = v1Routes.default;
  spec = (await owner.get('/api/v1/openapi.json')).data;
});
after(async () => { await srv.close(); });

test('every data endpoint the app serves is also reachable with an API key', async () => {
  // The routers the app mounts for company data, in the same order as server/app.js.
  const modules = await Promise.all(['company', 'projects', 'expenses', 'tasks', 'discussions', 'activity', 'apikeys']
    .map((name) => import(`../server/routes/${name}.js`)));
  const appSide = new Set();
  for (const m of modules) collect(m.default, appSide);
  const apiSide = collect(v1Router);

  const missing = [...appSide].filter((route) => !apiSide.has(route) && !IDENTITY_ONLY.includes(route));
  assert.deepEqual(missing, [], `these app endpoints have no API equivalent - mount them in server/routes/v1.js or add them to IDENTITY_ONLY with a reason:\n  ${missing.join('\n  ')}`);

  // And the exclusions really are excluded.
  for (const route of IDENTITY_ONLY) assert.ok(!apiSide.has(route), `${route} must not be reachable with an API key`);
});

test('every endpoint on /api/v1 is described in the OpenAPI document', () => {
  const documented = new Set();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) documented.add(key(method, path));
  }
  const served = collect(v1Router);
  const undocumented = [...served].filter((route) => !documented.has(route) && !UNDOCUMENTED_OK.includes(route));
  assert.deepEqual(undocumented, [], `add these to server/openapi.js so they show up in the API tab:\n  ${undocumented.join('\n  ')}`);
});

test('the OpenAPI document does not promise endpoints that do not exist', () => {
  const served = collect(v1Router);
  const phantom = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) {
      if (!served.has(key(method, path))) phantom.push(`${method.toUpperCase()} ${path}`);
    }
  }
  assert.deepEqual(phantom, [], `documented but not implemented:\n  ${phantom.join('\n  ')}`);
});

test('every documented endpoint answers rather than 404ing', async () => {
  const secret = (await owner.post('/api/keys', { name: 'Parity', scope: 'read', password: 'first-long-password' })).data.secret;
  const headers = { Authorization: `Bearer ${secret}` };
  const checked = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!methods.get) continue;
    // Only GETs are safe to probe blind; ids that do not exist give an honest 404 of their own.
    if (path.includes('{')) continue;
    const res = await owner.get(`/api/v1${path}`, { headers, noCsrf: true });
    checked.push(path);
    assert.notEqual(res.status, 404, `${path} is documented but the server does not serve it`);
    assert.equal(res.status, 200, `${path} answered ${res.status}`);
  }
  assert.ok(checked.length >= 8, `expected to probe a decent number of endpoints, probed ${checked.length}`);
});

test('the app and the API share one implementation', () => {
  // If these ever diverge, someone has written a second copy of a handler.
  const shared = ['GET /tasks', 'POST /tasks', 'GET /discussions', 'POST /discussions/{}/posts', 'GET /expenses/summary'];
  const appSide = collect(appRouter, collect(v1Router));
  for (const route of shared) assert.ok(appSide.has(route), `${route} should be served by a shared router`);
});
