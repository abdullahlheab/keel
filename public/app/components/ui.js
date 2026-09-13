// Small reusable UI atoms: icons, avatars, badges, headers, empty states, menus.
import { h, svg, initials, STATUS } from '../dom.js';

const ICONS = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  receipt: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM8 8h8M8 12h8M8 16h5',
  board: 'M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v7h-4z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  x: 'M18 6 6 18M6 6l12 12',
  chevronDown: 'm6 9 6 6 6-6',
  chevronRight: 'm9 6 6 6-6 6',
  chevronLeft: 'm15 6-6 6 6 6',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  upload: 'M12 16V4m0 0-4 4m4-4 4 4M4 20h16',
  download: 'M12 4v12m0 0-4-4m4 4 4-4M4 20h16',
  check: 'm5 12 5 5L20 7',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  tag: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01',
  calendar: 'M3 5h18v16H3zM16 3v4M8 3v4M3 10h18',
  more: 'M12 12h.01M12 5h.01M12 19h.01',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  paperclip: 'm21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
  filter: 'M22 3H2l8 9.5V19l4 2v-8.5z',
  arrowRight: 'M5 12h14m-6-6 6 6-6 6',
  menu: 'M3 6h18M3 12h18M3 18h18',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7V5a2 2 0 0 1 2-2h11v4M16 14h.01',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L19 3.2m-3.5 3.5 2 2',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  checkSquare: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  trendUp: 'm22 7-8.5 8.5-5-5L2 17M16 7h6v6',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5 4h14l3 8v8H2v-8z',
};

export function icon(name, { size = 18, cls = '' } = {}) {
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: `icon ${cls}`.trim(), 'aria-hidden': 'true' },
    svg('path', { d: ICONS[name] || ICONS.more }));
}

export function avatar(member, { size = 'md', title } = {}) {
  const name = member?.name || '?';
  const el = h('span', { class: `avatar avatar-${size}`, title: title ?? name, 'aria-label': name }, initials(name));
  if (member?.avatarColor) el.style.setProperty('--avatar', member.avatarColor);
  return el;
}

export function badge(text, cls = '') { return h('span', { class: `badge ${cls}`.trim() }, text); }

export function statusBadge(kind, value) {
  const def = STATUS[kind]?.[value];
  if (!def) return badge(value || '—');
  if (kind === 'task') {
    const el = h('span', { class: 'badge badge-dot' }, h('span', { class: 'dot' }), def.label);
    el.querySelector('.dot').style.background = def.color;
    return el;
  }
  return badge(def.label, def.cls);
}

export function priorityBadge(priority) {
  const def = STATUS.priority[priority] || STATUS.priority.medium;
  return h('span', { class: `prio ${def.cls}`, title: `${def.label} priority` }, h('span', { class: 'prio-bars' }, h('i'), h('i'), h('i')), def.label);
}

export function colorDot(color, size = 10) {
  const el = h('span', { class: 'color-dot' });
  el.style.background = color || 'var(--muted)';
  el.style.width = `${size}px`; el.style.height = `${size}px`;
  return el;
}

export function pageHeader({ title, subtitle, actions = [], crumbs = [] }) {
  return h('div', { class: 'page-header' },
    h('div', { class: 'page-header-text' },
      crumbs.length ? h('div', { class: 'crumbs' }, crumbs.map((c, i) => [i > 0 && icon('chevronRight', { size: 14 }), c.href ? h('a', { href: c.href }, c.label) : h('span', {}, c.label)])) : null,
      h('h1', { class: 'page-title' }, title),
      subtitle ? h('p', { class: 'page-subtitle' }, subtitle) : null),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null);
}

export function emptyState({ icon: name = 'inbox', title, text, action }) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon(name, { size: 28 })), h('h3', {}, title), text ? h('p', {}, text) : null, action || null);
}

export function spinner(label = 'Loading…') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner' }), h('span', {}, label));
}

export function errorBox(message, retry) {
  return h('div', { class: 'error-box' }, icon('alert'), h('span', {}, message), retry ? h('button', { class: 'btn btn-sm', onclick: retry }, 'Retry') : null);
}

export function button(label, { variant = '', size = '', icon: iconName, onclick, type = 'button', title, disabled, cls = '' } = {}) {
  return h('button', { class: `btn ${variant ? `btn-${variant}` : ''} ${size ? `btn-${size}` : ''} ${cls}`.replace(/\s+/g, ' ').trim(), onclick, type, title, disabled }, iconName ? icon(iconName, { size: size === 'sm' ? 14 : 16 }) : null, label);
}

export function iconButton(name, { onclick, title, cls = '', size = 16 } = {}) {
  return h('button', { class: `btn btn-icon ${cls}`.trim(), onclick, type: 'button', title, 'aria-label': title }, icon(name, { size }));
}

// Dropdown menu anchored to a trigger. items: [{label, icon, onclick, danger, divider}]
export function menu(trigger, items, { align = 'right' } = {}) {
  const wrap = h('div', { class: 'menu-wrap' });
  const list = h('div', { class: `menu menu-${align}`, role: 'menu', hidden: true });
  const close = () => { list.hidden = true; document.removeEventListener('click', onDoc, true); };
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  const open = () => { list.hidden = false; setTimeout(() => document.addEventListener('click', onDoc, true), 0); };
  for (const it of items) {
    if (!it) continue;
    if (it.divider) { list.appendChild(h('div', { class: 'menu-divider' })); continue; }
    list.appendChild(h('button', { class: `menu-item ${it.danger ? 'danger' : ''}`, role: 'menuitem', type: 'button', onclick: (e) => { e.stopPropagation(); close(); it.onclick?.(e); } }, it.icon ? icon(it.icon, { size: 15 }) : null, it.label));
  }
  trigger.addEventListener('click', (e) => { e.stopPropagation(); if (list.hidden) open(); else close(); });
  wrap.append(trigger, list);
  return wrap;
}

export function tabs(items, active, onSelect) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map((t) => h('button', { class: `tab ${t.id === active ? 'active' : ''}`, role: 'tab', type: 'button', 'aria-selected': t.id === active ? 'true' : 'false', onclick: () => onSelect(t.id) }, t.label, t.count !== undefined ? h('span', { class: 'tab-count' }, t.count) : null)));
}

export function kv(label, value) {
  return h('div', { class: 'kv' }, h('div', { class: 'kv-label' }, label), h('div', { class: 'kv-value' }, value));
}

export function copyButton(text, label = 'Copy') {
  const btn = button(label, { size: 'sm', icon: 'copy' });
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); btn.replaceChildren(icon('check', { size: 14 }), 'Copied'); setTimeout(() => btn.replaceChildren(icon('copy', { size: 14 }), label), 1500); }
    catch { btn.replaceChildren('Select and copy'); }
  });
  return btn;
}
