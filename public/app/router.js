// History-API router with a tiny pattern matcher.
const ROUTES = [
  ['login', '/login'],
  ['register', '/register'],
  ['mfa', '/mfa'],
  ['invite', '/invite/:token'],
  ['dashboard', '/'],
  ['projects', '/projects'],
  ['project', '/projects/:id'],
  ['expenses', '/expenses'],
  ['summary', '/expenses/summary'],
  ['board', '/board'],
  ['discussions', '/discussions'],
  ['discussion', '/discussions/:id'],
  ['activity', '/activity'],
  ['developers', '/developers'],
  ['settings', '/settings'],
  ['settings', '/settings/:tab'],
];

const compiled = ROUTES.map(([name, pattern]) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { name, re, keys };
});

export function matchRoute(path) {
  for (const r of compiled) {
    const m = path.match(r.re);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { name: r.name, params };
    }
  }
  return { name: 'notfound', params: {} };
}

export function currentLocation() {
  const path = window.location.pathname;
  const query = Object.fromEntries(new URLSearchParams(window.location.search));
  return { path, query, ...matchRoute(path) };
}

let onChange = () => {};

export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, window.location.origin);
  if (url.origin !== window.location.origin) { window.location.href = to; return; }
  if (replace) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  onChange(currentLocation());
}

export function setQuery(patch, { replace = true } = {}) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  navigate(url.pathname + url.search, { replace });
}

export function startRouter(handler) {
  onChange = handler;
  window.addEventListener('popstate', () => onChange(currentLocation()));
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download') || a.dataset.external !== undefined) return;
    const url = new URL(a.href, window.location.origin);
    if (url.origin !== window.location.origin) return;
    if (url.pathname.startsWith('/api/')) return;
    e.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
  onChange(currentLocation());
}
