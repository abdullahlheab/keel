// API tab: manage API keys, copy-paste examples, and an endpoint reference rendered from the OpenAPI document.
import { h, mount, date, relative, dateTime, number } from '../dom.js';
import { api } from '../api.js';
import { state, isAdmin } from '../state.js';
import { pageHeader, spinner, icon, button, badge, emptyState, tabs, copyButton } from '../components/ui.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { field, input, select, handleSubmit, formActions, row } from '../components/forms.js';
import { toast } from '../components/toast.js';
import { setQuery } from '../router.js';

const LANGS = [['curl', 'curl'], ['powershell', 'PowerShell'], ['javascript', 'JavaScript'], ['python', 'Python']];
const baseUrl = () => `${window.location.origin}/api/v1`;

export async function render(view, ctx) {
  const tab = ctx.query.tab || 'keys';
  const header = pageHeader({
    title: 'API',
    subtitle: 'Connect scripts, automations and other tools. Anything you can do with projects, tasks, discussions and expenses in the app, a key can do over HTTPS.',
    actions: [button('Create API key', { variant: 'primary', icon: 'plus', onclick: () => openCreateKey(ctx) })],
  });
  const tabBar = tabs([{ id: 'keys', label: 'API keys' }, { id: 'quickstart', label: 'Quick start' }, { id: 'reference', label: 'Reference' }], tab, (t) => setQuery({ tab: t === 'keys' ? null : t }, { replace: false }));
  const body = h('div', {}, spinner());
  mount(view, header, tabBar, body);
  if (tab === 'quickstart') renderQuickstart(body, ctx);
  else if (tab === 'reference') await renderReference(body);
  else await renderKeys(body, ctx);
}

// ---------- shared bits ----------
function codeBlock(text, { label } = {}) {
  return h('div', { class: 'code' },
    h('div', { class: 'code-head' }, h('span', {}, label || ''), copyButton(text, 'Copy')),
    h('pre', {}, h('code', {}, text)));
}

function methodBadge(method) { return h('span', { class: `method method-${method.toLowerCase()}` }, method.toUpperCase()); }

function snippet(lang, { method = 'GET', path, body }) {
  const url = `${baseUrl()}${path}`;
  const jsonText = body ? JSON.stringify(body, null, 2) : null;
  const indent = (text, pad) => text.split('\n').map((l, i) => (i ? pad + l : l)).join('\n');
  if (lang === 'powershell') {
    const head = '$headers = @{ Authorization = "Bearer $env:KEEL_API_KEY" }';
    if (!body) return `${head}\nInvoke-RestMethod -Uri "${url}" -Headers $headers${method !== 'GET' ? ` -Method ${cap(method)}` : ''}`;
    return `${head}\n$body = @'\n${jsonText}\n'@\nInvoke-RestMethod -Method ${cap(method)} -Uri "${url}" -Headers $headers -ContentType "application/json" -Body $body`;
  }
  if (lang === 'javascript') {
    const headers = body ? '{ Authorization: `Bearer ${process.env.KEEL_API_KEY}`, "Content-Type": "application/json" }' : '{ Authorization: `Bearer ${process.env.KEEL_API_KEY}` }';
    return `const res = await fetch("${url}", {\n${method !== 'GET' ? `  method: "${method}",\n` : ''}  headers: ${headers},${body ? `\n  body: JSON.stringify(${indent(jsonText, '  ')}),` : ''}\n});\nconst data = await res.json();\nconsole.log(data);`;
  }
  if (lang === 'python') {
    const py = jsonText ? jsonText.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None') : null;
    return `import os, requests\n\nres = requests.${method.toLowerCase()}(\n    "${url}",\n    headers={"Authorization": f"Bearer {os.environ['KEEL_API_KEY']}"},${py ? `\n    json=${indent(py, '    ')},` : ''}\n)\nprint(res.json())`;
  }
  const lines = [`curl ${method !== 'GET' ? `-X ${method} ` : ''}"${url}"`, '  -H "Authorization: Bearer $KEEL_API_KEY"'];
  if (body) lines.push('  -H "Content-Type: application/json"', `  -d '${jsonText}'`);
  return lines.join(' \\\n');
}
const cap = (m) => m[0] + m.slice(1).toLowerCase();
const plain = (text) => String(text || '').split(String.fromCharCode(96)).join('');

// ---------- keys ----------
async function renderKeys(body, ctx) {
  const res = await api.get('/api/keys');
  const active = res.items.filter((k) => k.state === 'active');
  const inactive = res.items.filter((k) => k.state !== 'active');

  const keyRow = (k) => h('div', { class: `key-row ${k.state !== 'active' ? 'inactive' : ''}` },
    h('div', { class: 'key-icon' }, icon('key', { size: 18 })),
    h('div', { class: 'info' },
      h('div', { class: 'flex', style: { gap: '8px', flexWrap: 'wrap' } }, h('b', {}, k.name), badge(k.scope === 'write' ? 'Read & write' : 'Read only', k.scope === 'write' ? 'badge-accent' : ''), k.state !== 'active' ? badge(k.state, k.state === 'revoked' ? 'badge-danger' : 'badge-warning') : null),
      h('div', { class: 'small muted' }, h('span', { class: 'mono' }, `${k.prefix}…`), ` · created ${date(k.createdAt)}${k.userName ? ` by ${k.userName}` : ''} · `,
        k.lastUsedAt ? h('span', { title: `${dateTime(k.lastUsedAt)}${k.lastUsedIp ? ` from ${k.lastUsedIp}` : ''}` }, `last used ${relative(k.lastUsedAt)}, ${number(k.requestCount)} request${k.requestCount === 1 ? '' : 's'}`) : 'never used',
        k.expiresAt && k.state === 'active' ? ` · expires ${date(k.expiresAt)}` : '')),
    k.state === 'active' ? button('Revoke', { size: 'sm', variant: 'danger', onclick: async () => {
      const ok = await confirmDialog({ title: `Revoke "${k.name}"?`, message: 'Anything using this key stops working immediately. This cannot be undone.', confirmText: 'Revoke key', danger: true });
      if (!ok) return;
      await api.del(`/api/keys/${k.id}`); toast('API key revoked'); ctx.refresh();
    } }) : null);

  const tester = buildTester();
  mount(body,
    h('div', { class: 'callout', style: { marginBottom: '16px' } }, icon('shield'), h('span', {}, h('b', {}, 'A key acts as you. '), `It has your role (${state.role}) in ${state.company.name} and nothing outside it. Anyone holding a key can read this company's data, and with a read & write key change it, so treat keys like passwords. Only a hash is stored, which is why a key is shown once.`)),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, `Active keys (${active.length})`), h('span', { class: 'small muted' }, res.canSeeAll ? 'Everyone\'s keys, because you are an admin' : 'Keys you created')),
      h('div', { class: 'card-body' }, active.length ? active.map(keyRow) : emptyState({ icon: 'key', title: 'No API keys yet', text: 'Create a key, then call the API from a script, Zapier, n8n, a spreadsheet, or anything that can send an HTTP request.', action: button('Create your first key', { variant: 'primary', icon: 'plus', onclick: () => openCreateKey(ctx) }) }))),
    h('div', { style: { height: '16px' } }),
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Test a key')), h('div', { class: 'card-body' }, tester)),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Where to go next')), h('div', { class: 'card-body stack' },
        h('a', { href: '/developers?tab=quickstart', class: 'flex' }, icon('code', { size: 16 }), 'Copy-paste examples in curl, PowerShell, JavaScript and Python'),
        h('a', { href: '/developers?tab=reference', class: 'flex' }, icon('list', { size: 16 }), 'Every endpoint, with its fields'),
        h('a', { href: '/api/v1/openapi.json', target: '_blank', rel: 'noopener', class: 'flex' }, icon('external', { size: 16 }), 'OpenAPI document for Postman, Insomnia or code generators'),
        h('div', { class: 'small muted' }, 'Base URL: ', h('span', { class: 'mono' }, baseUrl()))))),
    inactive.length ? [h('div', { class: 'section-title' }, 'Revoked and expired'), h('div', { class: 'card card-pad' }, inactive.slice(0, 20).map(keyRow))] : null);
}

function buildTester() {
  const keyInput = input({ type: 'password', placeholder: 'keel_…', autocomplete: 'off', spellcheck: 'false' });
  const out = h('div', { class: 'small', style: { marginTop: '10px' } });
  const form = h('form', { class: 'flex', style: { alignItems: 'flex-start' }, novalidate: true }, h('div', { class: 'grow' }, keyInput), h('button', { class: 'btn', type: 'submit' }, 'Test'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = keyInput.value.trim();
    if (!key) return;
    mount(out, spinner('Calling /api/v1/me…'));
    try {
      const res = await fetch('/api/v1/me', { headers: { Authorization: `Bearer ${key}` }, credentials: 'omit' });
      const data = await res.json();
      if (!res.ok) { mount(out, h('div', { class: 'error-box' }, icon('alert'), h('span', {}, `${res.status}: ${data.error}`))); return; }
      mount(out, h('div', { class: 'callout' }, icon('check'), h('span', {}, h('b', {}, `"${data.key.name}" works. `), `${data.key.scope === 'write' ? 'Read & write' : 'Read-only'} access to ${data.company.name}, acting as ${data.actingAs.name} (${data.actingAs.role}).`)));
    } catch { mount(out, h('div', { class: 'error-box' }, icon('alert'), h('span', {}, 'Could not reach the API.'))); }
  });
  return h('div', {}, h('p', { class: 'small text-2', style: { marginBottom: '10px' } }, 'Paste a key to check that it is valid and see what it can do. It is sent only to this server.'), form, out);
}

function openCreateKey(ctx) {
  const form = h('form', { class: 'form-grid', novalidate: true },
    field({ label: 'Name', name: 'name', required: true, input: input({ placeholder: 'e.g. Zapier, CI pipeline, Reporting script', required: true, maxlength: 60 }), hint: 'Shown in the activity log next to every change this key makes.' }),
    row(
      field({ label: 'Access', name: 'scope', input: select([{ value: 'write', label: 'Read & write' }, { value: 'read', label: 'Read only' }], { value: 'write' }), hint: 'Read only keys cannot create, change or delete anything.' }),
      field({ label: 'Expires', name: 'expiresInDays', input: select([{ value: '30', label: 'In 30 days' }, { value: '90', label: 'In 90 days' }, { value: '365', label: 'In 1 year' }], { value: '', placeholder: 'Never' }), hint: 'Short-lived keys limit the damage if one leaks.' })),
    field({ label: 'Your password', name: 'password', required: true, input: input({ type: 'password', autocomplete: 'current-password', required: true }), hint: 'Asked for again because a key keeps working after you sign out.' }),
    formActions(h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create key')));
  handleSubmit(form, async (data) => {
    const res = await api.post('/api/keys', { name: data.name, scope: data.scope, expiresInDays: data.expiresInDays ? Number(data.expiresInDays) : null, password: data.password });
    modal.close();
    showSecret(res, ctx);
  });
  const modal = openModal({ title: 'Create API key', content: form, size: 'md' });
}

function showSecret(res, ctx) {
  const secret = res.secret;
  const content = h('div', { class: 'stack', style: { gap: '14px' } },
    h('div', { class: 'callout warn' }, icon('alert'), h('span', {}, h('b', {}, 'Copy this key now. '), 'For security it is stored only as a hash, so it cannot be shown again. If you lose it, revoke it and create a new one.')),
    h('div', { class: 'invite-link' }, input({ value: secret, readOnly: true, onclick: (e) => e.target.select(), 'aria-label': 'API key' }), copyButton(secret, 'Copy key')),
    h('div', {}, h('div', { class: 'section-title', style: { margin: '0 0 8px' } }, 'Try it'),
      codeBlock(`curl "${baseUrl()}/me" -H "Authorization: Bearer ${secret}"`, { label: 'curl' }),
      h('div', { style: { height: '8px' } }),
      codeBlock(`Invoke-RestMethod -Uri "${baseUrl()}/me" -Headers @{ Authorization = "Bearer ${secret}" }`, { label: 'PowerShell' })),
    formActions(h('a', { class: 'btn left', href: '/developers?tab=quickstart', onclick: () => modal.close() }, 'See examples'), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => modal.close() }, 'I saved it')));
  const modal = openModal({ title: `Key created: ${res.key.name}`, content, size: 'lg', onClose: () => ctx.refresh() });
}

// ---------- quick start ----------
function renderQuickstart(body, ctx) {
  const lang = LANGS.some(([id]) => id === ctx.query.lang) ? ctx.query.lang : 'curl';
  const key = state.company?.key || 'KEY';
  const project = state.projects.find((p) => p.status !== 'archived');
  const projectId = project?.id || 'PROJECT_ID';
  const today = new Date().toISOString().slice(0, 10);
  const examples = [
    { title: 'Check your key', text: 'Returns the key, who it acts as, and the company. A good first call.', req: { path: '/me' } },
    { title: 'List tasks', text: 'Filter by status, project, assignee, priority, label, or search with q.', req: { path: '/tasks?status=todo' } },
    { title: 'Find your projects', text: project ? `You need a project id to put tasks on a project. "${project.name}" is ${project.id}.` : 'You need a project id to put tasks on a project.', req: { path: '/projects' } },
    { title: 'Create a task on a project', text: 'Only title is required. The response includes the new reference, such as ' + `${key}-42.`, req: { method: 'POST', path: `/projects/${projectId}/tasks`, body: { title: 'Follow up with the design agency', priority: 'high', dueDate: today, labels: ['from-api'] } } },
    { title: 'Change a task', text: `Use the task id or its reference (${key}-12). Send only what changes; send null to clear a field.`, req: { method: 'PATCH', path: `/tasks/${key}-12`, body: { status: 'in_progress', priority: 'urgent' } } },
    { title: 'Comment on a task', text: 'Useful for build results, alerts, or notes from another system.', req: { method: 'POST', path: `/tasks/${key}-12/comments`, body: { body: 'Deployed to production by the release pipeline.' } } },
    { title: 'Read the discussion room', text: `Topics sort pinned first, then by recent activity. Filter by category, state, project or author.`, req: { path: '/discussions?category=question&state=open' } },
    { title: 'Start a topic', text: `Categories are general, announcement, question, idea and decision. The response carries a reference such as ${key}-D4.`, req: { method: 'POST', path: '/discussions', body: { title: 'Do we still need the staging environment?', body: 'It costs about 40 a month and nobody has deployed to it since June.', category: 'decision' } } },
    { title: 'Reply to a topic', text: `Address a topic by id or reference (${key}-D4). Pass parentId to answer another reply.`, req: { method: 'POST', path: `/discussions/${key}-D4/posts`, body: { body: 'Agreed, let us shut it down at the end of the month.' } } },
    { title: 'Log an expense', text: 'amount is a decimal. Look up categoryId, projectId and paidByUserId with /categories, /projects and /members.', req: { method: 'POST', path: '/expenses', body: { amount: 249.99, date: today, vendor: 'Vercel', description: 'Pro plan', status: 'paid' } } },
    { title: 'Spending summary', text: 'Totals, the last 12 months, and breakdowns by project, category, payer and vendor.', req: { path: '/expenses/summary' } },
    { title: 'Poll for changes', text: 'Ask only for tasks changed since your last check. Works on /expenses too.', req: { path: `/tasks?updatedSince=${today}T00:00:00.000Z` } },
  ];
  const setKey = { curl: 'export KEEL_API_KEY="keel_…"', powershell: '$env:KEEL_API_KEY = "keel_…"', javascript: '# in your shell, before running node\nexport KEEL_API_KEY="keel_…"', python: '# in your shell, before running python\nexport KEEL_API_KEY="keel_…"' }[lang];

  mount(body,
    h('div', { class: 'grid grid-3', style: { marginBottom: '16px' } },
      stepCard(1, 'Create a key', h('span', {}, 'On the ', h('a', { href: '/developers' }, 'API keys'), ' tab. Pick read only if the tool never needs to change anything.')),
      stepCard(2, 'Use this base URL', h('span', { class: 'mono small', style: { wordBreak: 'break-all' } }, baseUrl())),
      stepCard(3, 'Send the key as a header', h('span', { class: 'mono small' }, 'Authorization: Bearer keel_…'))),
    h('div', { class: 'filters' }, h('div', { class: 'segmented' }, LANGS.map(([id, label]) => h('button', { type: 'button', class: id === lang ? 'active' : '', onclick: () => setQuery({ lang: id === 'curl' ? null : id }) }, label))), h('span', { class: 'small muted' }, 'Examples read the key from the KEEL_API_KEY environment variable so it never lands in your code.')),
    codeBlock(setKey, { label: 'Set the key once' }),
    h('div', { style: { height: '16px' } }),
    h('div', { class: 'stack', style: { gap: '16px' } }, examples.map((ex) => h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h3', { class: 'flex' }, methodBadge(ex.req.method || 'GET'), ex.title), h('div', { class: 'small muted', style: { marginTop: '3px' } }, ex.text))),
      h('div', { class: 'card-body' }, codeBlock(snippet(lang, ex.req), { label: LANGS.find(([id]) => id === lang)[1] }))))),
    h('div', { style: { height: '16px' } }),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Good to know')), h('div', { class: 'card-body' }, h('ul', { class: 'doc-list' },
      h('li', {}, h('b', {}, 'Errors '), 'come back as JSON with an HTTP status: ', h('span', { class: 'mono small' }, '{ "error": "message", "fields": { "title": "Required" } }'), '. 401 means a bad, revoked or expired key; 403 means the key or your role is not allowed to do that; 404 means it does not exist in this company.'),
      h('li', {}, h('b', {}, 'Money '), 'is returned as integer cents (amountCents, budgetCents) and accepted as a decimal (amount, budget).'),
      h('li', {}, h('b', {}, 'Ids '), 'are UUIDs. Tasks can also be addressed by reference, for example ', h('span', { class: 'mono small' }, `${key}-12`), '.'),
      h('li', {}, h('b', {}, 'Permissions '), 'follow the person who created the key. If they leave the company, their keys stop working.'),
      h('li', {}, h('b', {}, 'Rate limit: '), '300 requests per minute per key. A 429 response carries a Retry-After header.'),
      h('li', {}, h('b', {}, 'Audit trail: '), 'every change shows up in ', h('a', { href: '/activity' }, 'Activity'), ' marked with the key name.'),
      h('li', {}, h('b', {}, 'Browsers: '), 'the API allows cross-origin requests, but a key placed in a public web page is visible to everyone. Call it from a server or a script.')))));
}

function stepCard(n, title, content) {
  return h('div', { class: 'card card-pad stack', style: { gap: '6px' } }, h('div', { class: 'flex' }, h('span', { class: 'num-badge' }, n), h('b', {}, title)), h('div', { class: 'text-2' }, content));
}

// ---------- reference (rendered from the OpenAPI document) ----------
async function renderReference(body) {
  const res = await fetch('/api/v1/openapi.json', { credentials: 'omit' });
  const spec = await res.json();
  const resolve = (schema) => (schema?.$ref ? spec.components.schemas[schema.$ref.split('/').pop()] : schema);
  const typeOf = (s) => {
    const r = resolve(s) || {};
    if (r.enum) return r.enum.join(' | ');
    if (r.type === 'array') return `${typeOf(r.items)}[]`;
    return r.format === 'uuid' ? 'id' : r.format || r.type || 'object';
  };
  const byTag = new Map(spec.tags.map((t) => [t.name, []]));
  for (const [path, methods] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(methods)) byTag.get(op.tags[0])?.push({ path, method, op });

  const fieldTable = (schema) => {
    const s = resolve(schema);
    if (!s?.properties) return null;
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table doc-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'Type'), h('th', {}, 'Description'))),
      h('tbody', {}, Object.entries(s.properties).map(([name, def]) => h('tr', {},
        h('td', { class: 'mono nowrap' }, name, (s.required || []).includes(name) ? h('span', { class: 'req', title: 'Required when creating' }, ' *') : null),
        h('td', { class: 'mono small muted' }, typeOf(def)),
        h('td', { class: 'small' }, plain(resolve(def)?.description)))))));
  };

  const endpoint = ({ path, method, op }) => {
    const bodySchema = op.requestBody?.content?.['application/json']?.schema;
    const okResponse = op.responses?.['200'] || op.responses?.['201'];
    const responseSchema = okResponse?.content?.['application/json']?.schema;
    const resolvedResponse = resolve(responseSchema);
    const itemRef = resolvedResponse?.properties?.items?.items;
    return h('details', { class: 'endpoint' },
      h('summary', {}, methodBadge(method), h('span', { class: 'mono ep-path' }, path), h('span', { class: 'ep-summary' }, op.summary), method !== 'get' ? badge('write key', 'badge-warning') : null),
      h('div', { class: 'endpoint-body stack' },
        op.description ? h('p', { class: 'text-2' }, plain(op.description)) : null,
        op.parameters?.length ? h('div', {}, h('div', { class: 'section-title', style: { margin: '0 0 6px' } }, 'Parameters'), h('div', { class: 'table-wrap' }, h('table', { class: 'table doc-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'In'), h('th', {}, 'Description'))),
          h('tbody', {}, op.parameters.map((prm) => h('tr', {}, h('td', { class: 'mono nowrap' }, prm.name, prm.required ? h('span', { class: 'req' }, ' *') : null), h('td', { class: 'small muted' }, prm.in), h('td', { class: 'small' }, plain(prm.description), prm.schema?.enum ? h('div', { class: 'mono muted' }, prm.schema.enum.join(' | ')) : null))))))) : null,
        bodySchema ? h('div', {}, h('div', { class: 'section-title', style: { margin: '0 0 6px' } }, 'JSON body'), fieldTable(bodySchema)) : null,
        responseSchema?.$ref || itemRef ? h('div', {}, h('div', { class: 'section-title', style: { margin: '0 0 6px' } }, itemRef ? 'Returns { items: [...] } where each item has' : 'Returns'), fieldTable(itemRef || responseSchema)) : null,
        codeBlock(snippet('curl', { method: method.toUpperCase(), path: examplePath(path), body: bodySchema ? exampleBody(resolve(bodySchema)) : undefined }), { label: 'curl' })));
  };

  mount(body,
    h('div', { class: 'flex', style: { justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: '14px' } },
      h('div', { class: 'text-2' }, 'Base URL ', h('span', { class: 'mono' }, spec.servers[0].url), ' · version ', spec.info.version),
      h('a', { class: 'btn btn-sm', href: '/api/v1/openapi.json', target: '_blank', rel: 'noopener' }, icon('download', { size: 14 }), 'OpenAPI document')),
    [...byTag.entries()].map(([tag, ops]) => h('div', { class: 'card', style: { marginBottom: '16px' } },
      h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, tag), h('div', { class: 'small muted' }, plain(spec.tags.find((t) => t.name === tag)?.description)))),
      h('div', {}, ops.map(endpoint)))));
}

// Fills the {placeholders} in a documented path with something a reader can recognise.
function examplePath(path) {
  const key = state.company?.key || 'KEY';
  return path
    .replace('{id}', path.startsWith('/tasks') ? `${key}-12` : path.startsWith('/discussions') ? `${key}-D4` : 'ID')
    .replace(/\{(postId|commentId|userId)\}/, 'ID');
}

function exampleBody(schema) {
  const out = {};
  for (const [name, def] of Object.entries(schema.properties || {})) {
    if (!(schema.required || []).includes(name)) continue;
    if (def.enum) out[name] = def.enum[0];
    else if (def.type === 'array') out[name] = [];
    else if (def.type === 'integer') out[name] = 0;
    else if (def.type === 'number') out[name] = 49.5;
    else if (def.format === 'date') out[name] = new Date().toISOString().slice(0, 10);
    else out[name] = name === 'title' ? 'Something to do' : name === 'name' ? 'New project' : name === 'body' ? 'A comment' : '...';
  }
  return Object.keys(out).length ? out : { status: 'done' };
}
