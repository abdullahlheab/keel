import { h, mount } from './dom.js';
import { api, ApiError } from './api.js';
import { state, events, setSession, setCompanyData, loadTheme } from './state.js';
import { startRouter, navigate, currentLocation } from './router.js';
import { renderShell, setActiveNav } from './shell.js';
import { spinner, errorBox } from './components/ui.js';
import { closeContextMenu, removeSelectionBar } from './components/selection.js';
import * as auth from './views/auth.js';
import * as dashboard from './views/dashboard.js';
import * as projects from './views/projects.js';
import * as project from './views/project.js';
import * as expenses from './views/expenses.js';
import * as board from './views/board.js';
import * as discussions from './views/discussions.js';
import * as activity from './views/activity.js';
import * as settings from './views/settings.js';
import * as developers from './views/developers.js';

const root = document.getElementById('app');
const PUBLIC = new Set(['login', 'register', 'invite', 'mfa']);
const VIEWS = {
  dashboard: dashboard.render,
  projects: projects.render,
  project: project.render,
  expenses: expenses.render,
  summary: expenses.render,
  board: board.render,
  discussions: discussions.render,
  discussion: discussions.render,
  activity: activity.render,
  settings: settings.render,
  developers: developers.render,
};

let shellView = null;
let renderSeq = 0;
let mfaPending = false;

async function loadMe() {
  try {
    const me = await api.get('/api/auth/me');
    setSession(me);
    mfaPending = false;
  } catch (err) {
    setSession(null);
    mfaPending = err instanceof ApiError && err.status === 401 && Boolean(err.data?.mfaRequired);
  }
}

export async function refreshCompany() {
  const [company, projectList] = await Promise.all([api.get('/api/company'), api.get('/api/projects?includeArchived=1')]);
  setCompanyData(company);
  state.projects = projectList.items;
}

async function handleRoute(loc) {
  const seq = ++renderSeq;
  if (!state.user) {
    if (mfaPending && loc.name !== 'mfa') return navigate(`/mfa${loc.name === 'login' ? '' : `?next=${encodeURIComponent(loc.path)}`}`, { replace: true });
    if (!PUBLIC.has(loc.name)) return navigate(`/login?next=${encodeURIComponent(loc.path + (window.location.search || ''))}`, { replace: true });
    shellView = null;
    const ctx = { ...loc, onSignedIn };
    if (loc.name === 'login') return auth.renderLogin(root, ctx);
    if (loc.name === 'register') return auth.renderRegister(root, ctx);
    if (loc.name === 'invite') return auth.renderInvite(root, ctx);
    if (loc.name === 'mfa') return auth.renderMfa(root, ctx);
    return;
  }
  if (PUBLIC.has(loc.name) && loc.name !== 'invite') return navigate('/', { replace: true });
  if (loc.name === 'invite') { shellView = null; return auth.renderInvite(root, { ...loc, onSignedIn }); }

  if (!state.companyId) {
    shellView = null;
    return auth.renderNoCompany(root, { onSignedIn });
  }
  if (!shellView) {
    shellView = renderShell(root, { onSignOut: () => { setSession(null); shellView = null; navigate('/login'); } });
    mount(shellView, spinner());
    try { await refreshCompany(); } catch (err) { mount(shellView, errorBox(err.message, () => handleRoute(currentLocation()))); return; }
  }
  if (seq !== renderSeq) return;
  const view = VIEWS[loc.name];
  setActiveNav(loc.name);
  shellView.classList.toggle('wide', loc.name === 'board');
  if (!view) {
    mount(shellView, h('div', { class: 'empty' }, h('h3', {}, 'Page not found'), h('a', { href: '/' }, 'Back to dashboard')));
    return;
  }
  closeContextMenu();
  removeSelectionBar();
  const fresh = shellView.dataset.view !== loc.name;
  shellView.dataset.view = loc.name;
  if (fresh) window.scrollTo(0, 0);
  try {
    await view(shellView, { ...loc, fresh, refresh: () => handleRoute(currentLocation()), refreshCompany });
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    mount(shellView, errorBox(err.message || 'Failed to load', () => handleRoute(currentLocation())));
  }
}

async function onSignedIn(payload, next) {
  setSession(payload);
  mfaPending = false;
  shellView = null;
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  navigate(target, { replace: true });
}

events.addEventListener('signed-out', () => { shellView = null; navigate('/login', { replace: true }); });

loadTheme();
await loadMe();
startRouter(handleRoute);
