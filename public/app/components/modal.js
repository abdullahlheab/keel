import { h } from '../dom.js';
import { icon } from './ui.js';

const root = () => document.getElementById('modal-root');
const stack = [];

export function openModal({ title, content, size = 'md', onClose, headerExtra } = {}) {
  const overlay = h('div', { class: 'modal-overlay', role: 'presentation' });
  const dialog = h('div', { class: `modal modal-${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': typeof title === 'string' ? title : 'Dialog' });
  const body = h('div', { class: 'modal-body' });
  let closed = false;
  const close = (result) => {
    if (closed) return; closed = true;
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 120);
    const i = stack.indexOf(handle); if (i !== -1) stack.splice(i, 1);
    if (!stack.length) document.body.classList.remove('modal-open');
    onClose?.(result);
  };
  const handle = { close, body, dialog, setTitle: (t) => { titleEl.textContent = t; } };
  const titleEl = h('h2', { class: 'modal-title' }, title || '');
  dialog.append(
    h('div', { class: 'modal-header' }, titleEl, headerExtra || null, h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('x'))),
    body,
  );
  if (content) body.appendChild(typeof content === 'function' ? content(handle) : content);
  overlay.appendChild(dialog);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  const onKey = (e) => { if (e.key === 'Escape' && stack[stack.length - 1] === handle) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey);
  const origOnClose = onClose;
  onClose = (r) => { document.removeEventListener('keydown', onKey); origOnClose?.(r); };
  root().appendChild(overlay);
  stack.push(handle);
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    const first = dialog.querySelector('input:not([type=hidden]):not([disabled]), textarea, select, button.btn-primary');
    first?.focus();
  });
  return handle;
}

export function confirmDialog({ title = 'Are you sure?', message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({
      title,
      size: 'sm',
      onClose: () => resolve(result),
      content: (handle) => h('div', {},
        message ? h('p', { class: 'modal-text' }, message) : null,
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => handle.close() }, cancelText),
          h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', onclick: () => { result = true; handle.close(); } }, confirmText))),
    });
    setTimeout(() => m.dialog.querySelector('.modal-actions .btn:last-child')?.focus(), 0);
  });
}
