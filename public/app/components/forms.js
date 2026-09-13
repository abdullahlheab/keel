// Form building blocks + server field-error wiring.
import { h } from '../dom.js';
import { ApiError } from '../api.js';
import { toast } from './toast.js';

export function field({ label, name, input, hint, required, cls = '' }) {
  const id = input.id || `f-${name || Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  if (name && !input.name) input.name = name;
  return h('div', { class: `field ${cls}`.trim(), dataset: { field: name || '' } },
    label ? h('label', { for: id, class: 'field-label' }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null) : null,
    input,
    hint ? h('div', { class: 'field-hint' }, hint) : null,
    h('div', { class: 'field-error', hidden: true }));
}

export function input(props = {}) { return h('input', { class: 'input', type: 'text', ...props }); }
export function textarea(props = {}) { return h('textarea', { class: 'input textarea', rows: 3, ...props }); }

export function select(options, props = {}) {
  const { value, placeholder, ...rest } = props;
  const el = h('select', { class: 'input select', ...rest });
  if (placeholder !== undefined) el.appendChild(h('option', { value: '' }, placeholder));
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    if (o.disabled) opt.disabled = true;
    el.appendChild(opt);
  }
  if (value !== undefined && value !== null) {
    el.value = value;
    for (const opt of el.options) opt.defaultSelected = opt.selected; // so form.reset() returns here
  }
  return el;
}

export function checkbox({ label, ...props }) {
  const box = h('input', { type: 'checkbox', ...props });
  return h('label', { class: 'checkbox' }, box, h('span', {}, label));
}

export function moneyInput(props = {}) {
  return h('input', { class: 'input input-money', type: 'text', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off', ...props });
}

export function colorInput(props = {}) {
  return h('input', { class: 'input input-color', type: 'color', ...props });
}

// Read a form into a plain object (empty strings become null; checkboxes booleans).
export function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value === '' ? null : el.value;
  }
  return out;
}

export function clearErrors(form) {
  form.querySelectorAll('.field-error').forEach((e) => { e.hidden = true; e.textContent = ''; });
  form.querySelectorAll('.field.has-error').forEach((f) => f.classList.remove('has-error'));
  const top = form.querySelector('.form-error'); if (top) top.remove();
}

export function showErrors(form, err) {
  clearErrors(form);
  let shownInline = false;
  if (err?.fields) {
    for (const [name, msg] of Object.entries(err.fields)) {
      const f = form.querySelector(`.field[data-field="${CSS.escape(name)}"]`);
      if (f) { f.classList.add('has-error'); const e = f.querySelector('.field-error'); e.textContent = msg; e.hidden = false; shownInline = true; }
    }
  }
  if (!shownInline || !err?.fields) {
    const msg = err?.message || 'Something went wrong';
    form.prepend(h('div', { class: 'form-error', role: 'alert' }, msg));
  }
  form.querySelector('.has-error input, .has-error select, .has-error textarea')?.focus();
}

// Wraps a submit handler: disables the button, maps ApiErrors onto fields, toasts unexpected failures.
export function handleSubmit(form, fn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const btn = form.querySelector('button[type=submit]');
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    try {
      await fn(readForm(form), form);
    } catch (err) {
      if (err instanceof ApiError) showErrors(form, err);
      else { console.error(err); toast(err.message || 'Something went wrong', { type: 'error' }); }
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('busy'); if (label) btn.textContent = label; }
    }
  });
  return form;
}

export function formActions(...children) { return h('div', { class: 'modal-actions' }, children); }
export function row(...children) { return h('div', { class: 'form-row' }, children); }
