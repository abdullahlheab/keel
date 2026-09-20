// Hyperscript-style DOM helpers. Text goes through createTextNode, so it is XSS-safe by construction.
const SVG_NS = 'http://www.w3.org/2000/svg';
const PROP_KEYS = new Set(['value', 'checked', 'selected', 'disabled', 'readOnly', 'indeterminate', 'multiple', 'open']);

function applyProps(el, props, isSvg) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') { if (isSvg) el.setAttribute('class', v); else el.className = v; }
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (val === null || val === undefined) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, String(val));
        else el.style[prop] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'ref' && typeof v === 'function') v(el);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (!isSvg && PROP_KEYS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props, false);
  append(el, children);
  return el;
}

export function svg(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props, true);
  append(el, children);
  return el;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...children) { clear(el); append(el, children); return el; }

// ---------- formatting ----------
const moneyFmts = new Map();
export function money(cents, currency = 'USD', { compact = false } = {}) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  const key = `${currency}:${compact}`;
  if (!moneyFmts.has(key)) {
    try {
      moneyFmts.set(key, new Intl.NumberFormat(undefined, { style: 'currency', currency, notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : 2 }));
    } catch {
      moneyFmts.set(key, { format: (n) => `${n.toFixed(2)} ${currency}` });
    }
  }
  return moneyFmts.get(key).format(cents / 100);
}

export function number(n) { return new Intl.NumberFormat().format(n); }

export function date(iso, opts = {}) {
  if (!iso) return '—';
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), ...opts });
}

export function dateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function relative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d ago`;
  return date(iso);
}

export function monthLabel(key, { long = false } = {}) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: long ? 'long' : 'short', ...(long ? { year: 'numeric' } : {}) });
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysUntil(iso) {
  if (!iso) return null;
  const target = new Date(`${iso}T00:00:00`);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function centsToInput(cents) {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const STATUS = {
  task: {
    backlog: { label: 'Backlog', color: 'var(--muted)' },
    todo: { label: 'To do', color: 'var(--s1)' },
    in_progress: { label: 'In progress', color: 'var(--s4)' },
    review: { label: 'In review', color: 'var(--s7)' },
    done: { label: 'Done', color: 'var(--good)' },
  },
  priority: {
    low: { label: 'Low', cls: 'prio-low' },
    medium: { label: 'Medium', cls: 'prio-medium' },
    high: { label: 'High', cls: 'prio-high' },
    urgent: { label: 'Urgent', cls: 'prio-urgent' },
  },
  project: {
    planning: { label: 'Planning', cls: 'st-planning' },
    active: { label: 'Active', cls: 'st-active' },
    on_hold: { label: 'On hold', cls: 'st-hold' },
    completed: { label: 'Completed', cls: 'st-done' },
    archived: { label: 'Archived', cls: 'st-archived' },
  },
  expense: {
    pending: { label: 'Pending', cls: 'st-hold' },
    paid: { label: 'Paid', cls: 'st-active' },
    reimbursed: { label: 'Reimbursed', cls: 'st-done' },
  },
  topic: {
    general: { label: 'General', cls: 'st-planning' },
    announcement: { label: 'Announcement', cls: 'badge-accent' },
    question: { label: 'Question', cls: 'st-hold' },
    idea: { label: 'Idea', cls: 'cat-idea' },
    decision: { label: 'Decision', cls: 'st-done' },
  },
  topicState: {
    open: { label: 'Open', cls: 'st-planning' },
    resolved: { label: 'Resolved', cls: 'st-done' },
    archived: { label: 'Archived', cls: 'st-archived' },
  },
};
export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'];
export const TOPIC_CATEGORIES = ['general', 'announcement', 'question', 'idea', 'decision'];
export const TOPIC_STATES = ['open', 'resolved', 'archived'];
export const PAYMENT_METHODS = { card: 'Card', bank: 'Bank transfer', cash: 'Cash', other: 'Other' };
