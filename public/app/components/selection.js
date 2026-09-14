// Explorer-style multi-select (click, Ctrl/Shift+click, checkboxes, Ctrl+A, Esc, Delete),
// a right-click context menu with submenus, and a floating bar for the current selection.
import { h, mount } from '../dom.js';
import { icon } from './ui.js';

// ---------- context menu ----------
let openMenu = null;

export function closeContextMenu() {
  if (openMenu) { openMenu.cleanup(); openMenu = null; }
}

// items: { label, icon?, swatch?, checked?, shortcut?, danger?, disabled?, onclick?, children?: [...] } | { divider: true } | { header: 'text' }
export function contextMenu(x, y, items, { above = false } = {}) {
  closeContextMenu();
  const menu = h('div', { class: 'ctx-menu', role: 'menu' });
  buildItems(menu, items.filter(Boolean));
  if (!menu.childElementCount) return null;
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  let left = x; let top = above ? y - r.height : y;
  if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
  if (top < 8) top = 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const onDoc = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeContextMenu(); } };
  const onAway = () => closeContextMenu();
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('contextmenu', onDoc, true);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onAway, true);
  window.addEventListener('resize', onAway);
  openMenu = {
    cleanup() {
      menu.remove();
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('contextmenu', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onAway, true);
      window.removeEventListener('resize', onAway);
    },
  };
  menu.querySelector('.ctx-item:not([disabled])')?.focus({ preventScroll: true });
  return menu;
}

function buildItems(menu, items) {
  for (const it of items) {
    if (!it) continue;
    if (it.divider) { if (menu.lastElementChild && !menu.lastElementChild.classList.contains('ctx-divider')) menu.appendChild(h('div', { class: 'ctx-divider' })); continue; }
    if (it.header) { menu.appendChild(h('div', { class: 'ctx-header' }, it.header)); continue; }
    const iconEl = it.checked ? icon('check', { size: 14 })
      : it.swatch ? h('span', { class: 'color-dot', style: { background: it.swatch, width: '10px', height: '10px' } })
        : it.icon ? icon(it.icon, { size: 14 }) : null;
    const btn = h('button', { type: 'button', role: 'menuitem', class: `ctx-item ${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''}`.trim(), disabled: it.disabled ? true : null },
      h('span', { class: 'ctx-icon' }, iconEl),
      h('span', { class: 'ctx-label' }, it.label),
      it.shortcut ? h('span', { class: 'ctx-shortcut' }, it.shortcut) : null,
      it.children ? icon('chevronRight', { size: 14, cls: 'ctx-chev' }) : null);
    if (it.children) {
      const sub = h('div', { class: 'ctx-menu ctx-sub', role: 'menu' });
      buildItems(sub, it.children.filter(Boolean));
      const wrap = h('div', { class: 'ctx-item-wrap' }, btn, sub);
      const open = () => {
        wrap.parentElement?.querySelectorAll(':scope > .ctx-item-wrap.open').forEach((w) => { if (w !== wrap) w.classList.remove('open'); });
        wrap.classList.add('open');
        sub.classList.remove('flip');
        sub.style.top = '';
        const sr = sub.getBoundingClientRect();
        if (sr.right > window.innerWidth - 8) sub.classList.add('flip');
        if (sr.bottom > window.innerHeight - 8) sub.style.top = `${-Math.min(sr.top - 8, sr.bottom - (window.innerHeight - 8))}px`;
      };
      wrap.addEventListener('mouseenter', open);
      btn.addEventListener('click', (e) => { e.stopPropagation(); if (wrap.classList.contains('open')) wrap.classList.remove('open'); else open(); });
      btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); open(); sub.querySelector('.ctx-item')?.focus(); } });
      menu.appendChild(wrap);
    } else {
      btn.addEventListener('click', (e) => { e.stopPropagation(); closeContextMenu(); it.onclick?.(e); });
      menu.appendChild(btn);
    }
  }
  if (menu.lastElementChild?.classList.contains('ctx-divider')) menu.lastElementChild.remove();
}

// ---------- selection model ----------
// Items must carry data-id. A child with [data-select-toggle] acts as a checkbox.
export function createSelection({ root, itemSelector, initial = [], onChange, onOpen, onContext, onDelete }) {
  const ids = new Set(initial);
  let anchorId = null;
  const items = () => [...root.querySelectorAll(itemSelector)];
  const idOf = (el) => el.dataset.id;

  function paint() {
    root.classList.toggle('selecting', ids.size > 0);
    for (const el of items()) {
      const on = ids.has(idOf(el));
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    onChange?.(sel);
  }

  function selectRange(toId) {
    const order = items().map(idOf);
    const a = order.indexOf(anchorId);
    const b = order.indexOf(toId);
    if (a === -1 || b === -1) { ids.add(toId); return; }
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) ids.add(order[i]);
  }

  root.addEventListener('click', (e) => {
    const el = e.target.closest(itemSelector);
    if (!el || !root.contains(el)) return;
    const toggle = e.target.closest('[data-select-toggle]');
    if (!toggle && e.target.closest('a, button, input, select, textarea, label, [data-no-select]')) return;
    const id = idOf(el);
    if (e.shiftKey && anchorId) {
      e.preventDefault(); e.stopPropagation();
      if (!(e.ctrlKey || e.metaKey)) { const keep = ids.size ? [...ids] : []; ids.clear(); keep.forEach((k) => ids.add(k)); }
      selectRange(id); paint(); return;
    }
    if (toggle || e.ctrlKey || e.metaKey || ids.size > 0) {
      e.preventDefault(); e.stopPropagation();
      if (ids.has(id)) ids.delete(id); else ids.add(id);
      anchorId = id; paint(); return;
    }
    anchorId = id; // plain click with nothing selected: the view opens the item
  }, true);

  root.addEventListener('contextmenu', (e) => {
    const el = e.target.closest(itemSelector);
    if (!el || !root.contains(el)) return;
    e.preventDefault();
    const id = idOf(el);
    if (!ids.has(id)) { ids.clear(); ids.add(id); anchorId = id; paint(); }
    onContext?.(e, [...ids]);
  });

  const onKey = (e) => {
    if (!root.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (document.body.classList.contains('modal-open') || document.querySelector('.ctx-menu')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); sel.selectAll(); }
    else if (e.key === 'Escape' && ids.size) { sel.clear(); }
    else if (e.key === 'Delete' && ids.size) { e.preventDefault(); onDelete?.([...ids]); }
    else if (e.key === 'Enter' && ids.size === 1) { e.preventDefault(); onOpen?.([...ids][0]); }
  };
  document.addEventListener('keydown', onKey);

  const sel = {
    get count() { return ids.size; },
    has: (id) => ids.has(id),
    list: () => [...ids],
    clear() { ids.clear(); paint(); },
    set(list) { ids.clear(); list.forEach((i) => ids.add(i)); paint(); },
    selectAll() { for (const el of items()) ids.add(idOf(el)); paint(); },
    toggleAll() { if (ids.size && ids.size === items().length) sel.clear(); else sel.selectAll(); },
    paint,
    destroy() { document.removeEventListener('keydown', onKey); },
  };
  // prune ids that no longer exist in the DOM
  const present = new Set(items().map(idOf));
  for (const id of [...ids]) if (!present.has(id)) ids.delete(id);
  paint();
  return sel;
}

// The small square used as a checkbox on cards and rows.
export function selectBox({ title = 'Select' } = {}) {
  return h('span', { class: 'sel-box', 'data-select-toggle': '', role: 'checkbox', title, 'aria-label': title }, icon('check', { size: 12 }));
}

// ---------- floating selection bar ----------
export function selectionBar({ count, label = 'selected', actions = [], onClear }) {
  let bar = document.getElementById('selection-bar');
  if (!count) { bar?.remove(); return null; }
  if (!bar) { bar = h('div', { id: 'selection-bar', class: 'selection-bar', role: 'toolbar', 'aria-label': 'Selection actions' }); document.body.appendChild(bar); }
  mount(bar,
    h('span', { class: 'sel-count' }, icon('checkSquare', { size: 15 }), `${count} ${label}`),
    actions.filter(Boolean).map((a) => h('button', {
      type: 'button',
      class: `btn btn-sm ${a.danger ? 'btn-danger' : ''}`.trim(),
      title: a.title || null,
      onclick: (e) => {
        if (a.children) { const r = e.currentTarget.getBoundingClientRect(); contextMenu(r.left, r.top - 6, a.children, { above: true }); }
        else a.onclick?.(e);
      },
    }, a.icon ? icon(a.icon, { size: 14 }) : null, a.label, a.children ? icon('chevronDown', { size: 13 }) : null)),
    h('button', { class: 'btn btn-icon', type: 'button', title: 'Clear selection (Esc)', 'aria-label': 'Clear selection', onclick: onClear }, icon('x', { size: 15 })));
  return bar;
}

export function removeSelectionBar() { document.getElementById('selection-bar')?.remove(); }
