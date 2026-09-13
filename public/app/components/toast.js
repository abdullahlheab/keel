import { h } from '../dom.js';
import { icon } from './ui.js';

export function toast(message, { type = 'success', duration = 3500 } = {}) {
  const root = document.getElementById('toast-root');
  const el = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' },
    icon(type === 'error' ? 'alert' : type === 'info' ? 'clock' : 'check', { size: 16 }),
    h('span', {}, message));
  root.appendChild(el);
  const remove = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 200); };
  const t = setTimeout(remove, duration);
  el.addEventListener('click', () => { clearTimeout(t); remove(); });
  return el;
}
