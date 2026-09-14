// Expenses list with filters, the expense editor (with encrypted receipts), and the summary tab.
import { h, mount, money, date, number, todayIso, centsToInput, debounce, PAYMENT_METHODS, monthLabel } from '../dom.js';
import { api } from '../api.js';
import { state, currency, member, category, isAdmin } from '../state.js';
import { pageHeader, spinner, icon, avatar, button, emptyState, statusBadge, tabs, colorDot, iconButton } from '../components/ui.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { field, input, textarea, select, moneyInput, handleSubmit, formActions, row } from '../components/forms.js';
import { toast } from '../components/toast.js';
import { columnChart, barList, shareBar, meter, statTile } from '../components/charts.js';
import { createSelection, contextMenu, selectionBar, selectBox } from '../components/selection.js';
import { setQuery, navigate } from '../router.js';

const STATUS_OPTIONS = [['paid', 'Paid'], ['pending', 'Pending'], ['reimbursed', 'Reimbursed']].map(([value, label]) => ({ value, label }));
const RANGES = [
  { id: 'month', label: 'This month' }, { id: 'last', label: 'Last month' }, { id: '90', label: 'Last 90 days' },
  { id: 'year', label: 'This year' }, { id: 'all', label: 'All time' },
];

function rangeDates(id) {
  const now = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const first = (y, m) => new Date(y, m, 1);
  switch (id) {
    case 'month': return { from: iso(first(now.getFullYear(), now.getMonth())), to: null };
    case 'last': return { from: iso(first(now.getFullYear(), now.getMonth() - 1)), to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case '90': { const d = new Date(now); d.setDate(d.getDate() - 90); return { from: iso(d), to: null }; }
    case 'year': return { from: `${now.getFullYear()}-01-01`, to: null };
    default: return { from: null, to: null };
  }
}

function buildQuery(q) {
  const params = new URLSearchParams();
  for (const k of ['project', 'category', 'paidBy', 'status', 'q', 'from', 'to']) if (q[k]) params.set(k, q[k]);
  return params.toString();
}

export async function render(view, ctx) {
  const isSummary = ctx.name === 'summary';
  const tabBar = tabs([{ id: 'list', label: 'All expenses' }, { id: 'summary', label: 'Summary' }], isSummary ? 'summary' : 'list', (t) => navigate(t === 'summary' ? '/expenses/summary' : '/expenses'));
  if (isSummary) return renderSummary(view, ctx, tabBar);

  const q = ctx.query;
  const qs = buildQuery(q);
  if (!view.querySelector('.page-header')) mount(view, spinner());
  const res = await api.get(`/api/expenses?${qs}&limit=100`);
  const cur = currency();
  const rangeId = RANGES.find((r) => { const d = rangeDates(r.id); return (d.from || '') === (q.from || '') && (d.to || '') === (q.to || ''); })?.id || (q.from || q.to ? 'custom' : 'all');

  const filters = h('div', { class: 'filters' },
    h('div', { class: 'search' }, icon('search', { size: 15 }), input({ placeholder: 'Search vendor, description, notes', value: q.q || '', oninput: debounce((e) => setQuery({ q: e.target.value }), 300) })),
    select([{ value: 'none', label: 'No project' }, ...state.projects.map((p) => ({ value: p.id, label: p.name }))], { value: q.project || '', placeholder: 'All projects', onchange: (e) => setQuery({ project: e.target.value }) }),
    select([{ value: 'none', label: 'Uncategorised' }, ...state.categories.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.name }))], { value: q.category || '', placeholder: 'All categories', onchange: (e) => setQuery({ category: e.target.value }) }),
    select(state.members.map((m) => ({ value: m.id, label: m.name })), { value: q.paidBy || '', placeholder: 'Paid by anyone', onchange: (e) => setQuery({ paidBy: e.target.value }) }),
    select(STATUS_OPTIONS, { value: q.status || '', placeholder: 'Any status', onchange: (e) => setQuery({ status: e.target.value }) }),
    select([...RANGES.map((r) => ({ value: r.id, label: r.label })), { value: 'custom', label: 'Custom range…' }], { value: rangeId, onchange: (e) => {
      if (e.target.value === 'custom') return openRangeModal(q);
      const d = rangeDates(e.target.value); setQuery({ from: d.from, to: d.to });
    } }),
    (q.project || q.category || q.paidBy || q.status || q.q || q.from || q.to) ? button('Clear', { size: 'sm', variant: 'ghost', icon: 'x', onclick: () => navigate('/expenses') }) : null,
  );

  const table = res.items.length ? h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, expenseTable(res.items, { onChanged: ctx.refresh, footer: { total: res.total, sumCents: res.sumCents, currency: cur } })),
    res.total > res.items.length ? h('div', { class: 'card-foot' }, `Showing ${res.items.length} of ${res.total}. Narrow the filters or export to CSV for everything.`) : null)
    : emptyState({ icon: 'receipt', title: qs ? 'No expenses match these filters' : 'No expenses yet', text: qs ? 'Try widening the date range or clearing a filter.' : 'Log what the company spends, who paid, and attach receipts. Everything is encrypted at rest.', action: qs ? button('Clear filters', { onclick: () => navigate('/expenses') }) : button('Add expense', { variant: 'primary', icon: 'plus', onclick: () => openExpenseModal({ onSaved: ctx.refresh }) }) });

  mount(view,
    pageHeader({ title: 'Expenses', actions: [
      h('a', { class: 'btn', href: `/api/expenses/export.csv?${qs}`, download: '' }, icon('download', { size: 16 }), 'Export CSV'),
      button('Add expense', { variant: 'primary', icon: 'plus', onclick: () => openExpenseModal({ onSaved: ctx.refresh }) }),
    ] }),
    tabBar,
    filters,
    h('div', { class: 'total-strip' }, h('span', { class: 'big tnum' }, money(res.sumCents, cur)), h('span', { class: 'sub' }, `${number(res.total)} expense${res.total === 1 ? '' : 's'}${rangeId !== 'all' || q.from ? ' in the selected range' : ' in total'}`)),
    table);
}

function openRangeModal(q) {
  const form = h('form', { class: 'form-grid', novalidate: true },
    row(field({ label: 'From', name: 'from', input: input({ type: 'date', value: q.from || '' }) }), field({ label: 'To', name: 'to', input: input({ type: 'date', value: q.to || '' }) })),
    formActions(h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Apply')));
  handleSubmit(form, async (data) => { m.close(); setQuery({ from: data.from, to: data.to }); });
  const m = openModal({ title: 'Custom date range', content: form, size: 'sm' });
}

// Shared table used by the list page and the project page.
export function expenseTable(items, { onChanged, hideProject = false, footer = null } = {}) {
  const cur = currency();
  const rows = items.map((e) => {
    const proj = state.projects.find((p) => p.id === e.projectId);
    const cat = category(e.categoryId);
    const payer = member(e.paidByUserId);
    return h('tr', { class: 'clickable', dataset: { id: e.id }, onclick: () => openExpenseModal({ expense: e, onSaved: onChanged }) },
      h('td', { class: 'sel-cell' }, selectBox({ title: 'Select expense' })),
      h('td', { class: 'nowrap' }, date(e.date)),
      h('td', {}, h('div', { class: 'cell-main flex', style: { gap: '6px' } }, e.vendor || e.description || 'Expense', e.receipts?.length ? h('span', { title: `${e.receipts.length} receipt${e.receipts.length === 1 ? '' : 's'}`, class: 'muted flex' }, icon('paperclip', { size: 13 })) : null, e.recurring ? h('span', { class: 'badge', title: `Recurring ${e.recurring}` }, e.recurring) : null),
        e.vendor && e.description ? h('div', { class: 'cell-sub truncate', style: { maxWidth: '360px' } }, e.description) : null),
      h('td', {}, cat ? h('span', { class: 'flex', style: { gap: '6px' } }, colorDot(cat.color, 8), cat.name) : h('span', { class: 'muted' }, '—')),
      hideProject ? null : h('td', {}, proj ? h('a', { href: `/projects/${proj.id}`, class: 'flex', style: { gap: '6px', color: 'inherit' }, onclick: (ev) => ev.stopPropagation() }, colorDot(proj.color, 8), h('span', { class: 'truncate', style: { maxWidth: '180px' } }, proj.name)) : h('span', { class: 'muted' }, '—')),
      h('td', {}, payer ? h('span', { class: 'flex', style: { gap: '6px' } }, avatar(payer, { size: 'xs' }), h('span', { class: 'hide-mobile' }, payer.name.split(' ')[0])) : h('span', { class: 'muted' }, 'Company')),
      h('td', {}, statusBadge('expense', e.status)),
      h('td', { class: 'num' }, h('span', { class: `amount ${e.amountCents < 0 ? 'neg' : ''}` }, money(e.amountCents, e.currency || cur))));
  });
  const byId = new Map(items.map((e) => [e.id, e]));
  const headBox = h('span', { class: 'sel-box', role: 'checkbox', title: 'Select all', 'aria-label': 'Select all', 'data-no-select': '' });
  const table = h('table', { class: 'table expense-table' },
    h('thead', {}, h('tr', {}, h('th', { class: 'sel-cell' }, headBox), h('th', {}, 'Date'), h('th', {}, 'Expense'), h('th', {}, 'Category'), hideProject ? null : h('th', {}, 'Project'), h('th', {}, 'Paid by'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Amount'))),
    h('tbody', {}, rows),
    footer ? h('tfoot', {}, h('tr', {}, h('td', { colspan: hideProject ? 6 : 7 }, `${number(footer.total)} expense${footer.total === 1 ? '' : 's'}`), h('td', { class: 'num' }, money(footer.sumCents, footer.currency)))) : null);
  const sel = createSelection({
    root: table,
    itemSelector: 'tbody tr[data-id]',
    onChange: (s) => {
      headBox.classList.toggle('on', s.count > 0 && s.count === items.length);
      const ids = s.list();
      selectionBar({
        count: ids.length,
        label: ids.length === 1 ? 'expense selected' : `expenses selected · ${money(ids.reduce((sum, id) => sum + (byId.get(id)?.amountCents || 0), 0), cur)}`,
        onClear: () => s.clear(),
        actions: ids.length ? [
          { label: 'Mark as', icon: 'check', children: expenseStatusItems(ids, byId, onChanged) },
          { label: 'Category', icon: 'tag', children: expenseCategoryItems(ids, byId, onChanged) },
          { label: 'Project', icon: 'folder', children: expenseProjectItems(ids, byId, onChanged) },
          { label: 'Paid by', icon: 'users', children: expensePayerItems(ids, byId, onChanged) },
          { label: 'Export', icon: 'download', onclick: () => downloadSelectedCsv(ids) },
          { label: 'Delete', icon: 'trash', danger: true, onclick: () => deleteExpenses(ids, onChanged) },
        ] : [],
      });
    },
    onOpen: (id) => openExpenseModal({ expense: byId.get(id), onSaved: onChanged }),
    onContext: (e, ids) => contextMenu(e.clientX, e.clientY, expenseMenuItems(ids, byId, onChanged)),
    onDelete: (ids) => deleteExpenses(ids, onChanged),
  });
  headBox.addEventListener('click', (e) => { e.stopPropagation(); sel.toggleAll(); });
  return table;
}

// ---------- bulk actions on selected expenses ----------
function bulkExpenses(ids, onChanged, action, data, message) {
  return async () => {
    try {
      const r = await api.post('/api/expenses/bulk', { ids, action, data });
      toast(message || (r.deleted ? `Deleted ${r.deleted}` : `Updated ${ids.length} expense${ids.length === 1 ? '' : 's'}`), { duration: 2000 });
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
    onChanged?.();
  };
}
function sameExpenseValue(ids, byId, key) {
  const values = new Set(ids.map((id) => byId.get(id)?.[key] ?? null));
  return values.size === 1 ? [...values][0] : undefined;
}
function expenseStatusItems(ids, byId, onChanged) {
  const current = sameExpenseValue(ids, byId, 'status');
  return STATUS_OPTIONS.map((s) => ({ label: s.label, checked: current === s.value, onclick: bulkExpenses(ids, onChanged, 'update', { status: s.value }, `Marked as ${s.label.toLowerCase()}`) }));
}
function expenseCategoryItems(ids, byId, onChanged) {
  const current = sameExpenseValue(ids, byId, 'categoryId');
  return [
    ...state.categories.filter((c) => !c.archived).map((c) => ({ label: c.name, swatch: current === c.id ? null : c.color, checked: current === c.id, onclick: bulkExpenses(ids, onChanged, 'update', { categoryId: c.id }, `Categorised as ${c.name}`) })),
    { divider: true },
    { label: 'Uncategorised', checked: current === null, onclick: bulkExpenses(ids, onChanged, 'update', { categoryId: null }, 'Category cleared') },
  ];
}
function expenseProjectItems(ids, byId, onChanged) {
  const current = sameExpenseValue(ids, byId, 'projectId');
  return [
    ...state.projects.filter((p) => p.status !== 'archived').map((p) => ({ label: p.name, swatch: current === p.id ? null : p.color, checked: current === p.id, onclick: bulkExpenses(ids, onChanged, 'update', { projectId: p.id }, `Moved to ${p.name}`) })),
    { divider: true },
    { label: 'No project', checked: current === null, onclick: bulkExpenses(ids, onChanged, 'update', { projectId: null }, 'Removed from project') },
  ];
}
function expensePayerItems(ids, byId, onChanged) {
  const current = sameExpenseValue(ids, byId, 'paidByUserId');
  return [
    ...state.members.map((m) => ({ label: m.name, checked: current === m.id, onclick: bulkExpenses(ids, onChanged, 'update', { paidByUserId: m.id }, `Paid by ${m.name}`) })),
    { divider: true },
    { label: 'Company account', checked: current === null, onclick: bulkExpenses(ids, onChanged, 'update', { paidByUserId: null }, 'Paid from company account') },
  ];
}
function expenseMenuItems(ids, byId, onChanged) {
  const n = ids.length;
  const single = n === 1 ? byId.get(ids[0]) : null;
  const current = sameExpenseValue(ids, byId, 'recurring');
  const total = money(ids.reduce((sum, id) => sum + (byId.get(id)?.amountCents || 0), 0), currency());
  return [
    single ? { label: 'Open', icon: 'external', shortcut: 'Enter', onclick: () => openExpenseModal({ expense: single, onSaved: onChanged }) } : { header: `${n} expenses · ${total}` },
    { divider: true },
    { label: 'Mark as', icon: 'check', children: expenseStatusItems(ids, byId, onChanged) },
    { label: 'Category', icon: 'tag', children: expenseCategoryItems(ids, byId, onChanged) },
    { label: 'Project', icon: 'folder', children: expenseProjectItems(ids, byId, onChanged) },
    { label: 'Paid by', icon: 'users', children: expensePayerItems(ids, byId, onChanged) },
    { label: 'Recurring', icon: 'refresh', children: [
      { label: 'One-off', checked: current === null, onclick: bulkExpenses(ids, onChanged, 'update', { recurring: null }, 'Marked as one-off') },
      { label: 'Monthly', checked: current === 'monthly', onclick: bulkExpenses(ids, onChanged, 'update', { recurring: 'monthly' }, 'Tagged monthly') },
      { label: 'Yearly', checked: current === 'yearly', onclick: bulkExpenses(ids, onChanged, 'update', { recurring: 'yearly' }, 'Tagged yearly') },
    ] },
    { divider: true },
    { label: n === 1 ? 'Export as CSV' : `Export ${n} as CSV`, icon: 'download', onclick: () => downloadSelectedCsv(ids) },
    { label: 'Copy as text', icon: 'copy', onclick: async () => {
      const text = ids.map((id) => byId.get(id)).filter(Boolean).map((e) => `${e.date}  ${money(e.amountCents, e.currency || currency())}  ${e.vendor || ''}${e.vendor && e.description ? ' - ' : ''}${e.description || ''}`).join('\n');
      try { await navigator.clipboard.writeText(text); toast(`Copied ${n} expense${n === 1 ? '' : 's'} as text`); } catch { toast('Could not copy', { type: 'error' }); }
    } },
    { divider: true },
    { label: n === 1 ? 'Delete' : `Delete ${n} expenses`, icon: 'trash', danger: true, shortcut: 'Del', onclick: () => deleteExpenses(ids, onChanged) },
  ];
}
function downloadSelectedCsv(ids) {
  const a = h('a', { href: `/api/expenses/export.csv?ids=${ids.join(',')}`, download: '' });
  document.body.appendChild(a); a.click(); a.remove();
}
async function deleteExpenses(ids, onChanged) {
  const n = ids.length;
  const ok = await confirmDialog({ title: n === 1 ? 'Delete this expense?' : `Delete ${n} expenses?`, message: 'Attached receipts are deleted too. This cannot be undone.', confirmText: n === 1 ? 'Delete' : `Delete ${n}`, danger: true });
  if (!ok) return;
  await bulkExpenses(ids, onChanged, 'delete', undefined, n === 1 ? 'Expense deleted' : `Deleted ${n} expenses`)();
}

export function openExpenseModal({ expense = null, defaults = {}, onSaved } = {}) {
  const isEdit = Boolean(expense);
  const e = expense || { date: todayIso(), status: 'paid', paidByUserId: state.user.id, paymentMethod: 'card', ...defaults };
  const canEdit = !isEdit || isAdmin() || expense.createdBy === state.user.id || expense.paidByUserId === state.user.id;
  const cur = e.currency || currency();
  const pendingFiles = [];

  const amount = moneyInput({ value: centsToInput(e.amountCents), name: 'amount', required: true, autofocus: !isEdit });
  const receiptsBox = h('div', { class: 'stack', style: { gap: '8px' } });
  const fileInput = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true, onchange: (ev) => { for (const f of ev.target.files) addFile(f); ev.target.value = ''; } });
  const dropzone = h('div', { class: 'dropzone', tabindex: 0, role: 'button', onclick: () => fileInput.click(), onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); } } }, icon('upload', { size: 16 }), ' Drop a receipt here or click to upload (image or PDF, up to 10 MB)');
  dropzone.addEventListener('dragover', (ev) => { ev.preventDefault(); dropzone.classList.add('over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (ev) => { ev.preventDefault(); dropzone.classList.remove('over'); for (const f of ev.dataTransfer.files) addFile(f); });

  function fmtSize(n) { return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }
  function receiptItem(r) {
    return h('div', { class: 'receipt-item' }, icon(r.mime === 'application/pdf' ? 'receipt' : 'paperclip', { size: 15 }),
      h('a', { class: 'name', href: `/api/receipts/${r.id}`, target: '_blank', rel: 'noopener', title: r.filename }, r.filename),
      h('span', { class: 'size' }, fmtSize(r.size)),
      h('a', { class: 'btn btn-icon', href: `/api/receipts/${r.id}?download=1`, download: r.filename, title: 'Download' }, icon('download', { size: 15 })),
      canEdit ? iconButton('trash', { title: 'Remove receipt', onclick: async () => { const ok = await confirmDialog({ title: 'Remove this receipt?', confirmText: 'Remove', danger: true }); if (!ok) return; await api.del(`/api/receipts/${r.id}`); e.receipts = e.receipts.filter((x) => x.id !== r.id); renderReceipts(); onSaved?.(); } }) : null);
  }
  function pendingItem(f, i) {
    return h('div', { class: 'receipt-item' }, icon('clock', { size: 15 }), h('span', { class: 'name' }, f.name), h('span', { class: 'size' }, `${fmtSize(f.size)} · uploads on save`), iconButton('x', { title: 'Remove', onclick: () => { pendingFiles.splice(i, 1); renderReceipts(); } }));
  }
  function renderReceipts() {
    mount(receiptsBox, (e.receipts || []).map(receiptItem), pendingFiles.map(pendingItem), canEdit ? dropzone : null, fileInput);
  }
  function addFile(f) {
    if (f.size > 10 * 1024 * 1024) return toast(`${f.name} is larger than 10 MB`, { type: 'error' });
    if (!/^image\//.test(f.type) && f.type !== 'application/pdf') return toast('Receipts must be an image or PDF', { type: 'error' });
    pendingFiles.push(f); renderReceipts();
  }
  renderReceipts();

  const form = h('form', { class: 'form-grid', novalidate: true },
    row(
      field({ label: `Amount (${cur})`, name: 'amount', required: true, input: h('div', { class: 'money-wrap' }, h('span', { class: 'cur' }, cur), amount) }),
      field({ label: 'Date', name: 'date', required: true, input: input({ type: 'date', value: e.date, required: true }) })),
    row(
      field({ label: 'Vendor / payee', name: 'vendor', input: input({ value: e.vendor || '', placeholder: 'e.g. AWS, Notion, Delta' }) }),
      field({ label: 'Category', name: 'categoryId', input: select(state.categories.filter((c) => !c.archived || c.id === e.categoryId).map((c) => ({ value: c.id, label: c.name })), { value: e.categoryId || '', placeholder: 'Uncategorised' }) })),
    field({ label: 'Description', name: 'description', input: input({ value: e.description || '', placeholder: 'What was this for?' }) }),
    row(
      field({ label: 'Project', name: 'projectId', input: select(state.projects.filter((p) => p.status !== 'archived' || p.id === e.projectId).map((p) => ({ value: p.id, label: p.name })), { value: e.projectId || '', placeholder: 'No project (company overhead)' }) }),
      field({ label: 'Paid by', name: 'paidByUserId', input: select(state.members.map((m) => ({ value: m.id, label: m.name })), { value: e.paidByUserId || '', placeholder: 'Company account' }), hint: 'Who fronted the money. Useful for settling up.' })),
    h('div', { class: 'form-row three' },
      field({ label: 'Status', name: 'status', input: select(STATUS_OPTIONS, { value: e.status || 'paid' }) }),
      field({ label: 'Payment method', name: 'paymentMethod', input: select(Object.entries(PAYMENT_METHODS).map(([value, label]) => ({ value, label })), { value: e.paymentMethod || '', placeholder: '—' }) }),
      field({ label: 'Recurring', name: 'recurring', input: select([{ value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' }], { value: e.recurring || '', placeholder: 'One-off' }) })),
    field({ label: 'Notes', name: 'notes', input: textarea({ value: e.notes || '', rows: 2, placeholder: 'Anything else worth remembering (encrypted).' }) }),
    h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Receipts'), receiptsBox),
    formActions(
      isEdit && canEdit ? h('button', { class: 'btn btn-danger left', type: 'button', onclick: async () => {
        const ok = await confirmDialog({ title: 'Delete this expense?', message: 'Attached receipts are deleted too. This cannot be undone.', confirmText: 'Delete', danger: true });
        if (!ok) return;
        await api.del(`/api/expenses/${expense.id}`); toast('Expense deleted'); modal.close(); onSaved?.();
      } }, 'Delete') : null,
      h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, canEdit ? 'Cancel' : 'Close'),
      canEdit ? h('button', { class: 'btn btn-primary', type: 'submit' }, isEdit ? 'Save changes' : 'Add expense') : null));
  if (!canEdit) form.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });

  handleSubmit(form, async (data) => {
    const body = { ...data, currency: cur };
    const saved = isEdit ? await api.patch(`/api/expenses/${expense.id}`, body) : await api.post('/api/expenses', body);
    let failed = 0;
    for (const f of pendingFiles) {
      try { await api.upload(`/api/expenses/${saved.id}/receipts`, f); } catch (err) { failed += 1; console.error(err); }
    }
    toast(isEdit ? 'Expense updated' : `Expense added${failed ? ` (${failed} receipt upload${failed === 1 ? '' : 's'} failed)` : ''}`, { type: failed ? 'error' : 'success' });
    modal.close();
    onSaved?.(saved);
  });
  const modal = openModal({ title: isEdit ? (canEdit ? 'Edit expense' : 'Expense') : 'New expense', content: form, size: 'lg' });
  return modal;
}

// ---------- summary tab ----------
async function renderSummary(view, ctx, tabBar) {
  const q = ctx.query;
  const rangeId = q.range || 'all';
  const d = rangeDates(rangeId);
  const params = new URLSearchParams();
  if (d.from) params.set('from', d.from);
  if (d.to) params.set('to', d.to);
  if (q.project) params.set('project', q.project);
  if (!view.querySelector('.page-header')) mount(view, spinner());
  const s = await api.get(`/api/expenses/summary?${params}`);
  const cur = s.currency;
  const t = s.totals;
  const monthsInRange = rangeId === 'month' ? 1 : rangeId === 'last' ? 1 : rangeId === '90' ? 3 : rangeId === 'year' ? (new Date().getMonth() + 1) : Math.max(1, s.byMonth.filter((m) => m.count).length);
  const rangeLabel = RANGES.find((r) => r.id === rangeId)?.label || 'All time';
  const linkTo = (extra) => `/expenses?${new URLSearchParams({ ...(d.from ? { from: d.from } : {}), ...(d.to ? { to: d.to } : {}), ...(q.project ? { project: q.project } : {}), ...extra })}`;

  const filters = h('div', { class: 'filters' },
    h('div', { class: 'segmented' }, RANGES.map((r) => h('button', { type: 'button', class: r.id === rangeId ? 'active' : '', onclick: () => setQuery({ range: r.id === 'all' ? null : r.id }) }, r.label))),
    select(state.projects.map((p) => ({ value: p.id, label: p.name })), { value: q.project || '', placeholder: 'All projects', onchange: (e) => setQuery({ project: e.target.value }) }));

  const kpis = h('div', { class: 'grid grid-4' },
    statTile({ label: `Total · ${rangeLabel.toLowerCase()}`, value: money(t.rangeCents, cur), hint: `${number(t.rangeCount)} expense${t.rangeCount === 1 ? '' : 's'}`, hero: false }),
    statTile({ label: 'Average per month', value: money(Math.round(t.rangeCents / monthsInRange), cur), hint: `over ${monthsInRange} month${monthsInRange === 1 ? '' : 's'}` }),
    statTile({ label: 'Pending reimbursement', value: money(t.pendingCents, cur), hint: t.pendingCount ? [h('a', { href: '/expenses?status=pending' }, `${t.pendingCount} expense${t.pendingCount === 1 ? '' : 's'} waiting`)] : 'Nothing outstanding' }),
    statTile({ label: 'Monthly recurring', value: money(t.recurringMonthlyCents, cur), hint: 'subscriptions tagged monthly or yearly' }));

  const trend = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Spending by month'), h('span', { class: 'small muted' }, 'last 12 months, all projects')),
    h('div', { class: 'card-body' }, t.count ? columnChart({ series: s.byMonth, currency: cur, currentKey: new Date().toISOString().slice(0, 7), onSelect: (m) => navigate(`/expenses?from=${m.month}-01&to=${m.month}-31`) }) : h('p', { class: 'muted small' }, 'No expenses yet.')));

  const byProject = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'By project')),
    h('div', { class: 'card-body stack', style: { gap: '18px' } }, shareBar({ items: s.byProject, currency: cur }), barList({ items: s.byProject, currency: cur, sub: (i) => i.budgetCents != null ? `${Math.round((i.cents / i.budgetCents) * 100)}% of budget` : `${i.count} expense${i.count === 1 ? '' : 's'}`, onClick: (i) => navigate(linkTo({ project: i.projectId || 'none' })) })));
  const byCategory = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'By category')),
    h('div', { class: 'card-body' }, barList({ items: s.byCategory, currency: cur, sub: (i) => `${Math.round((i.cents / Math.max(1, t.rangeCents)) * 100)}%`, onClick: (i) => navigate(linkTo({ category: i.categoryId || 'none' })) })));
  const byPayer = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Who paid'), h('span', { class: 'small muted' }, 'for settling up')),
    h('div', { class: 'card-body' }, barList({ items: s.byPayer.map((p) => ({ ...p, color: p.avatarColor || 'var(--muted)' })), currency: cur, sub: (i) => `${i.count} expense${i.count === 1 ? '' : 's'}`, onClick: (i) => i.userId && navigate(linkTo({ paidBy: i.userId })) })));
  const vendors = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Top vendors')),
    s.topVendors.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Vendor'), h('th', { class: 'num' }, 'Expenses'), h('th', { class: 'num' }, 'Total'))),
      h('tbody', {}, s.topVendors.map((v) => h('tr', { class: 'clickable', onclick: () => navigate(linkTo({ q: v.vendor })) }, h('td', { class: 'cell-main' }, v.vendor), h('td', { class: 'num' }, v.count), h('td', { class: 'num amount' }, money(v.cents, cur))))))) : h('p', { class: 'card-body muted small' }, 'Add a vendor to expenses to see this.'));
  const budgets = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Budgets'), h('span', { class: 'small muted' }, 'all-time spend vs budget')),
    h('div', { class: 'card-body stack' }, s.budgets.length ? s.budgets.map((b) => meter({ ...b, currency: cur, href: `/projects/${b.projectId}` })) : h('p', { class: 'muted small' }, 'Set a budget on a project to track it here.')));

  mount(view,
    pageHeader({ title: 'Expenses', actions: [h('a', { class: 'btn', href: `/api/expenses/export.csv?${params}`, download: '' }, icon('download', { size: 16 }), 'Export CSV'), button('Add expense', { variant: 'primary', icon: 'plus', onclick: () => openExpenseModal({ onSaved: ctx.refresh }) })] }),
    tabBar, filters, kpis,
    h('div', { style: { height: '16px' } }),
    trend,
    h('div', { style: { height: '16px' } }),
    h('div', { class: 'grid grid-2' }, byProject, byCategory),
    h('div', { style: { height: '16px' } }),
    h('div', { class: 'grid grid-3' }, byPayer, vendors, budgets));
}
