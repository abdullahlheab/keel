// Application chrome: sidebar navigation, company switcher, quick-create, user menu.
import { h, mount } from './dom.js';
import { state, events, selectCompany, applyTheme } from './state.js';
import { api } from './api.js';
import { navigate } from './router.js';
import { icon, avatar, menu, button } from './components/ui.js';
import { toast } from './components/toast.js';
import { openExpenseModal } from './views/expenses.js';
import { openTaskModal } from './views/board.js';
import { openProjectModal } from './views/projects.js';

const NAV = [
  { name: 'dashboard', href: '/', label: 'Dashboard', icon: 'dashboard' },
  { name: 'projects', href: '/projects', label: 'Projects', icon: 'folder', count: () => state.counts.projects },
  { name: 'expenses', href: '/expenses', label: 'Expenses', icon: 'receipt', match: ['expenses', 'summary'] },
  { name: 'board', href: '/board', label: 'Task board', icon: 'board', count: () => state.counts.openTasks },
  { name: 'activity', href: '/activity', label: 'Activity', icon: 'activity' },
  { name: 'settings', href: '/settings', label: 'Settings', icon: 'settings' },
];

let els = null;

export function renderShell(root, { onSignOut }) {
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' });
  const viewEl = h('div', { class: 'view', id: 'view' });
  const backdrop = h('div', { class: 'sidebar-backdrop', hidden: true, onclick: () => closeDrawer() });
  const topbar = h('div', { class: 'topbar' },
    h('button', { class: 'btn btn-icon', 'aria-label': 'Menu', onclick: () => openDrawer() }, icon('menu')),
    h('span', { class: 'title' }, state.company?.name || 'Company Tracker'),
    button('New', { variant: 'primary', size: 'sm', icon: 'plus', onclick: (e) => quickMenu(e.currentTarget) }));
  const main = h('main', { class: 'main' }, topbar, viewEl);
  mount(root, h('div', { class: 'app' }, sidebar, main), backdrop);
  els = { sidebar, viewEl, backdrop, topbar, onSignOut };
  buildSidebar();
  events.addEventListener('company', buildSidebar);
  events.addEventListener('session', buildSidebar);
  return viewEl;
}

function openDrawer() { els.sidebar.classList.add('open'); els.backdrop.hidden = false; }
function closeDrawer() { els.sidebar.classList.remove('open'); els.backdrop.hidden = true; }

function quickMenu(anchor) {
  // Build a transient menu next to the topbar button
  const items = quickItems();
  const wrap = menu(h('span'), items, { align: 'right' });
  anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
  wrap.querySelector('.menu').hidden = false;
  const close = () => wrap.remove();
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
}

function quickItems() {
  return [
    { label: 'New expense', icon: 'receipt', onclick: () => openExpenseModal() },
    { label: 'New task', icon: 'checkSquare', onclick: () => openTaskModal() },
    { label: 'New project', icon: 'folder', onclick: () => openProjectModal() },
  ];
}

function buildSidebar() {
  if (!els) return;
  const { sidebar } = els;
  const company = state.company;
  const brandBtn = h('button', { class: 'brand', type: 'button', title: 'Switch company' },
    h('span', { class: 'brand-key' }, company?.key || 'CT'),
    h('span', { class: 'grow' }, h('div', { class: 'brand-name truncate' }, company?.name || 'Company Tracker'), h('div', { class: 'brand-sub' }, state.role ? `${state.role} · ${state.members.length || 1} member${state.members.length === 1 ? '' : 's'}` : '')),
    state.companies.length > 1 ? icon('chevronDown', { size: 14 }) : null);
  const brand = state.companies.length > 1
    ? menu(brandBtn, state.companies.map((c) => ({ label: `${c.name} (${c.role})`, icon: c.id === state.companyId ? 'check' : 'folder', onclick: () => { selectCompany(c.id); window.location.reload(); } })), { align: 'left' })
    : brandBtn;

  const newBtn = menu(button('New', { variant: 'primary', icon: 'plus', cls: 'new-btn' }), quickItems(), { align: 'left' });

  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.map((n) => {
    const count = n.count?.();
    return h('a', { href: n.href, dataset: { nav: n.name, match: (n.match || [n.name]).join(',') }, onclick: closeDrawer }, icon(n.icon, { size: 17 }), n.label, count ? h('span', { class: 'nav-count' }, count) : null);
  }));

  const themeBtn = menu(
    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', style: { justifyContent: 'flex-start' } }, icon(state.theme === 'dark' ? 'moon' : 'sun', { size: 15 }), `Theme: ${state.theme}`),
    ['system', 'light', 'dark'].map((t) => ({ label: t[0].toUpperCase() + t.slice(1), icon: t === state.theme ? 'check' : (t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'settings'), onclick: () => { applyTheme(t); buildSidebar(); } })),
    { align: 'left' },
  );
  themeBtn.querySelector('.menu').classList.add('menu-up');

  const userBtn = h('button', { class: 'user-chip', type: 'button' }, avatar(state.user, { size: 'sm' }), h('span', { class: 'grow' }, h('div', { class: 'name truncate' }, state.user?.name), h('div', { class: 'role' }, state.role || '')), icon('chevronDown', { size: 14 }));
  const userMenu = menu(userBtn, [
    { label: 'Profile & security', icon: 'shield', onclick: () => navigate('/settings') },
    { label: 'Members & invites', icon: 'users', onclick: () => navigate('/settings/members') },
    { divider: true },
    { label: 'Sign out', icon: 'logout', onclick: async () => { try { await api.post('/api/auth/logout'); } catch { /* ignore */ } els.onSignOut(); } },
  ], { align: 'left' });
  userMenu.querySelector('.menu').classList.add('menu-up');

  mount(sidebar,
    brand,
    newBtn,
    nav,
    h('div', { class: 'sidebar-spacer' }),
    h('div', { class: 'sidebar-footer' }, themeBtn, userMenu));
  if (els.topbar) els.topbar.querySelector('.title').textContent = company?.name || 'Company Tracker';
  setActiveNav(currentActive);
}

let currentActive = 'dashboard';
export function setActiveNav(name) {
  currentActive = name;
  if (!els) return;
  els.sidebar.querySelectorAll('.nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.match.split(',').includes(name));
  });
}

export function notifyError(err) { toast(err?.message || 'Something went wrong', { type: 'error' }); }
