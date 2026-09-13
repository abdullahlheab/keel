// Kanban board, list view, and the task editor.
import { h, mount, date, todayIso, daysUntil, relative, debounce, STATUS, TASK_STATUSES, dateTime } from '../dom.js';
import { api } from '../api.js';
import { state, member, isAdmin } from '../state.js';
import { pageHeader, spinner, icon, avatar, button, emptyState, statusBadge, priorityBadge, colorDot, iconButton } from '../components/ui.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { field, input, textarea, select, handleSubmit, formActions, row } from '../components/forms.js';
import { toast } from '../components/toast.js';
import { enableColumnDnd } from '../components/dnd.js';
import { setQuery } from '../router.js';

const PRIORITIES = [['urgent', 'Urgent'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']].map(([value, label]) => ({ value, label }));
const STATUS_OPTIONS = TASK_STATUSES.map((s) => ({ value: s, label: STATUS.task[s].label }));
const PRIO_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };

function applyFilters(items, q) {
  let out = items;
  if (q.project === 'none') out = out.filter((t) => !t.projectId);
  else if (q.project) out = out.filter((t) => t.projectId === q.project);
  if (q.assignee === 'me') out = out.filter((t) => t.assigneeUserId === state.user.id);
  else if (q.assignee === 'none') out = out.filter((t) => !t.assigneeUserId);
  else if (q.assignee) out = out.filter((t) => t.assigneeUserId === q.assignee);
  if (q.priority) out = out.filter((t) => t.priority === q.priority);
  if (q.label) out = out.filter((t) => t.labels.includes(q.label));
  if (q.q) { const n = q.q.toLowerCase(); out = out.filter((t) => t.title.toLowerCase().includes(n) || `${state.company.key}-${t.number}`.toLowerCase().includes(n) || t.labels.some((l) => l.toLowerCase().includes(n))); }
  return out;
}

let openedFromQuery = null;

export async function render(view, ctx) {
  const q = ctx.query;
  if (!view.querySelector('.kanban')) mount(view, spinner());
  const res = await api.get('/api/tasks');
  const all = res.items;
  const items = applyFilters(all, q);
  const listMode = q.view === 'list';
  const labels = [...new Set(all.flatMap((t) => t.labels))].sort();

  const filters = h('div', { class: 'filters' },
    h('div', { class: 'search' }, icon('search', { size: 15 }), input({ placeholder: 'Search tasks', value: q.q || '', oninput: debounce((e) => setQuery({ q: e.target.value }), 250) })),
    select([{ value: 'none', label: 'No project' }, ...state.projects.filter((p) => p.status !== 'archived').map((p) => ({ value: p.id, label: p.name }))], { value: q.project || '', placeholder: 'All projects', onchange: (e) => setQuery({ project: e.target.value }) }),
    select([{ value: 'me', label: 'Assigned to me' }, { value: 'none', label: 'Unassigned' }, ...state.members.map((m) => ({ value: m.id, label: m.name }))], { value: q.assignee || '', placeholder: 'Anyone', onchange: (e) => setQuery({ assignee: e.target.value }) }),
    select(PRIORITIES, { value: q.priority || '', placeholder: 'Any priority', onchange: (e) => setQuery({ priority: e.target.value }) }),
    labels.length ? select(labels.map((l) => ({ value: l, label: l })), { value: q.label || '', placeholder: 'Any label', onchange: (e) => setQuery({ label: e.target.value }) }) : null,
    (q.project || q.assignee || q.priority || q.q || q.label) ? button('Clear', { size: 'sm', variant: 'ghost', icon: 'x', onclick: () => setQuery({ project: null, assignee: null, priority: null, q: null, label: null }) }) : null,
    h('div', { class: 'spacer' }),
    h('div', { class: 'segmented' },
      h('button', { type: 'button', class: listMode ? '' : 'active', onclick: () => setQuery({ view: null }) }, icon('board', { size: 14 }), ' Board'),
      h('button', { type: 'button', class: listMode ? 'active' : '', onclick: () => setQuery({ view: 'list' }) }, icon('list', { size: 14 }), ' List')));

  const open = all.filter((t) => t.status !== 'done').length;
  const header = pageHeader({
    title: 'Task board',
    subtitle: `${open} open · ${all.length - open} done · ${all.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < todayIso()).length} overdue`,
    actions: [button('New task', { variant: 'primary', icon: 'plus', onclick: () => openTaskModal({ defaults: { projectId: q.project && q.project !== 'none' ? q.project : null }, onSaved: ctx.refresh }) })],
  });

  const body = listMode ? renderList(items, ctx) : renderBoard(items, ctx, all.length === 0);
  mount(view, header, filters, body);

  if (q.task && openedFromQuery !== q.task) {
    openedFromQuery = q.task;
    openTaskModal({ taskId: q.task, onSaved: ctx.refresh, onClose: () => { openedFromQuery = null; setQuery({ task: null }); } });
  }
}

function renderBoard(items, ctx, nothingAtAll) {
  if (nothingAtAll) {
    return emptyState({ icon: 'board', title: 'Your board is empty', text: 'Tasks move across Backlog, To do, In progress, In review and Done. Drag cards between columns.', action: button('Create the first task', { variant: 'primary', icon: 'plus', onclick: () => openTaskModal({ onSaved: ctx.refresh }) }) });
  }
  const board = h('div', { class: 'kanban' });
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  for (const status of TASK_STATUSES) {
    let colTasks = items.filter((t) => t.status === status).sort((a, b) => a.position - b.position);
    let hidden = [];
    if (status === 'done') {
      hidden = colTasks.filter((t) => t.completedAt && t.completedAt < cutoff);
      colTasks = colTasks.filter((t) => !hidden.includes(t));
    }
    const bodyEl = h('div', { class: 'kcol-body', dataset: { status } }, colTasks.map((t) => card(t, ctx)));
    if (hidden.length) bodyEl.appendChild(h('button', { class: 'kcol-more', type: 'button', onclick: (e) => { e.target.replaceWith(...hidden.map((t) => card(t, ctx))); } }, `Show ${hidden.length} older`));
    const dot = h('span', { class: 'dot' }); dot.style.background = STATUS.task[status].color;
    board.appendChild(h('div', { class: 'kcol', dataset: { status } },
      h('div', { class: 'kcol-head' }, dot, STATUS.task[status].label, h('span', { class: 'count' }, colTasks.length + hidden.length), iconButton('plus', { title: `Add to ${STATUS.task[status].label}`, onclick: () => openTaskModal({ defaults: { status, projectId: ctx.query.project && ctx.query.project !== 'none' ? ctx.query.project : null }, onSaved: ctx.refresh }) })),
      bodyEl));
  }
  enableColumnDnd(board, {
    onDrop: async ({ id, status, index, fromStatus }) => {
      const cardEl = board.querySelector(`.kcard[data-id="${id}"]`);
      if (cardEl) { cardEl.dataset.status = status; cardEl.classList.toggle('done', status === 'done'); }
      updateCounts(board);
      try {
        await api.post(`/api/tasks/${id}/move`, { status, index });
        if (fromStatus !== status) toast(`Moved to ${STATUS.task[status].label}`, { duration: 1500 });
      } catch (err) {
        toast(err.message, { type: 'error' });
        ctx.refresh();
      }
    },
  });
  return h('div', { class: 'board-wrap' }, board);
}

function updateCounts(board) {
  board.querySelectorAll('.kcol').forEach((col) => { col.querySelector('.count').textContent = col.querySelectorAll('.kcard').length; });
}

function card(t, ctx) {
  const proj = state.projects.find((p) => p.id === t.projectId);
  const assignee = member(t.assigneeUserId);
  const due = t.dueDate ? daysUntil(t.dueDate) : null;
  const done = t.checklist.filter((c) => c.done).length;
  const el = h('div', { class: `kcard ${t.status === 'done' ? 'done' : ''}`, draggable: true, dataset: { id: t.id, status: t.status }, onclick: () => openTaskModal({ taskId: t.id, onSaved: ctx.refresh }) },
    h('div', { class: 'kc-top' }, h('span', { class: 'kc-ref' }, `${state.company.key}-${t.number}`), proj ? h('span', { class: 'kc-project' }, colorDot(proj.color, 7), proj.name) : null),
    h('div', { class: 'kc-title' }, t.title),
    t.labels.length ? h('div', { class: 'kc-labels' }, t.labels.slice(0, 4).map((l) => h('span', { class: 'label-chip' }, l))) : null,
    h('div', { class: 'kc-foot' },
      priorityBadge(t.priority),
      due !== null && t.status !== 'done' ? h('span', { class: `kc-meta ${due < 0 ? 'overdue' : due <= 2 ? 'soon' : ''}`, title: `Due ${date(t.dueDate)}` }, icon('calendar', { size: 12 }), due < 0 ? `${-due}d late` : due === 0 ? 'Today' : due === 1 ? 'Tomorrow' : date(t.dueDate)) : null,
      t.checklist.length ? h('span', { class: 'kc-meta', title: 'Checklist' }, icon('checkSquare', { size: 12 }), `${done}/${t.checklist.length}`) : null,
      t.commentCount ? h('span', { class: 'kc-meta', title: 'Comments' }, icon('message', { size: 12 }), t.commentCount) : null,
      assignee ? avatar(assignee, { size: 'xs' }) : null));
  return el;
}

function renderList(items, ctx) {
  if (!items.length) return emptyState({ icon: 'list', title: 'No tasks match', text: 'Try clearing a filter.' });
  const sorted = [...items].sort((a, b) => TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status) || PRIO_RANK[a.priority] - PRIO_RANK[b.priority] || (a.dueDate || '9').localeCompare(b.dueDate || '9'));
  return h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Task'), h('th', {}, 'Status'), h('th', {}, 'Priority'), h('th', {}, 'Assignee'), h('th', {}, 'Due'))),
    h('tbody', {}, sorted.map((t) => taskRow(t, { onOpen: () => openTaskModal({ taskId: t.id, onSaved: ctx.refresh }) }))))));
}

export function taskRow(t, { onOpen }) {
  const proj = state.projects.find((p) => p.id === t.projectId);
  const assignee = member(t.assigneeUserId);
  const due = t.dueDate ? daysUntil(t.dueDate) : null;
  return h('tr', { class: 'clickable', onclick: onOpen },
    h('td', {}, h('div', { class: 'cell-main flex', style: { gap: '8px' } }, h('span', { class: 'mono small muted' }, `${state.company.key}-${t.number}`), t.title, t.labels.slice(0, 3).map((l) => h('span', { class: 'label-chip' }, l))), proj ? h('div', { class: 'cell-sub flex', style: { gap: '5px' } }, colorDot(proj.color, 7), proj.name) : null),
    h('td', {}, statusBadge('task', t.status)),
    h('td', {}, priorityBadge(t.priority)),
    h('td', {}, assignee ? h('span', { class: 'flex', style: { gap: '6px' } }, avatar(assignee, { size: 'xs' }), assignee.name.split(' ')[0]) : h('span', { class: 'muted' }, '—')),
    h('td', { class: 'nowrap', style: due !== null && due < 0 && t.status !== 'done' ? { color: 'var(--critical-text)', fontWeight: 600 } : null }, t.dueDate ? date(t.dueDate) : h('span', { class: 'muted' }, '—')));
}

// ---------- task editor ----------
export async function openTaskModal({ taskId = null, defaults = {}, onSaved, onClose } = {}) {
  if (!taskId) return openCreateModal(defaults, onSaved, onClose);
  let task;
  try { task = await api.get(`/api/tasks/${taskId}`); } catch (err) { toast(err.message, { type: 'error' }); onClose?.(); return null; }
  let changed = false;
  const ref = `${state.company.key}-${task.number}`;
  const canDelete = isAdmin() || task.createdBy === state.user.id;
  const savedHint = h('span', { class: 'saved-hint', style: { opacity: 0 } }, icon('check', { size: 12 }), 'Saved');
  let hintTimer;
  async function patch(body) {
    try {
      const updated = await api.patch(`/api/tasks/${task.id}`, body);
      Object.assign(task, updated);
      changed = true;
      savedHint.style.opacity = 1; clearTimeout(hintTimer); hintTimer = setTimeout(() => { savedHint.style.opacity = 0; }, 1500);
      return true;
    } catch (err) { toast(err.message, { type: 'error' }); return false; }
  }

  // --- main column
  const title = input({ class: 'input input-title', value: task.title, 'aria-label': 'Title' });
  title.addEventListener('blur', () => { const v = title.value.trim(); if (v && v !== task.title) patch({ title: v }); else title.value = task.title; });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });

  const descBox = h('div');
  function renderDesc() {
    const viewEl = h('div', { class: `desc-view ${task.description ? '' : 'placeholder'}`, tabindex: 0, role: 'button' }, task.description || 'Add a description…');
    const edit = () => {
      const ta = textarea({ value: task.description || '', rows: 5, placeholder: 'Add a description…' });
      ta.addEventListener('blur', async () => { const v = ta.value.trim(); if (v !== (task.description || '')) await patch({ description: v || null }); renderDesc(); });
      mount(descBox, ta); ta.focus();
    };
    viewEl.addEventListener('click', edit);
    viewEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') edit(); });
    mount(descBox, viewEl);
  }
  renderDesc();

  const checklistBox = h('div', { class: 'checklist' });
  function renderChecklist() {
    const doneN = task.checklist.filter((c) => c.done).length;
    const addInput = input({ placeholder: 'Add a checklist item', class: 'input' });
    const add = async () => { const text = addInput.value.trim(); if (!text) return; await patch({ checklist: [...task.checklist, { text, done: false }] }); renderChecklist(); checklistBox.querySelector('.check-add input')?.focus(); };
    addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    mount(checklistBox,
      task.checklist.length ? h('div', { class: 'small muted', style: { marginBottom: '4px' } }, `${doneN} of ${task.checklist.length} done`) : null,
      task.checklist.map((item) => h('div', { class: `check-item ${item.done ? 'done' : ''}` },
        h('input', { type: 'checkbox', checked: item.done, onchange: async (e) => { await patch({ checklist: task.checklist.map((c) => c.id === item.id ? { ...c, done: e.target.checked } : c) }); renderChecklist(); } }),
        h('span', { class: 'text' }, item.text),
        iconButton('x', { title: 'Remove', size: 13, onclick: async () => { await patch({ checklist: task.checklist.filter((c) => c.id !== item.id) }); renderChecklist(); } }))),
      h('div', { class: 'check-add' }, addInput, button('Add', { size: 'sm', onclick: add })));
  }
  renderChecklist();

  const commentsBox = h('div', { class: 'comments' });
  function renderComments() {
    const ta = textarea({ placeholder: 'Write a comment…', rows: 2 });
    const post = async () => {
      const body = ta.value.trim(); if (!body) return;
      try { const c = await api.post(`/api/tasks/${task.id}/comments`, { body }); task.comments.push(c); task.commentCount = (task.commentCount || 0) + 1; changed = true; renderComments(); } catch (err) { toast(err.message, { type: 'error' }); }
    };
    ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') post(); });
    mount(commentsBox,
      task.comments.map((c) => {
        const who = member(c.userId);
        return h('div', { class: 'comment' }, avatar(who || { name: '?' }, { size: 'sm' }),
          h('div', { class: 'comment-body' },
            h('div', { class: 'comment-head' }, h('b', {}, who?.name || 'Former member'), h('span', { class: 'muted small', title: dateTime(c.createdAt) }, relative(c.createdAt)), c.updatedAt ? h('span', { class: 'muted small' }, '(edited)') : null,
              (c.userId === state.user.id || isAdmin()) ? iconButton('trash', { title: 'Delete comment', size: 13, onclick: async () => { const ok = await confirmDialog({ title: 'Delete this comment?', confirmText: 'Delete', danger: true }); if (!ok) return; await api.del(`/api/tasks/${task.id}/comments/${c.id}`); task.comments = task.comments.filter((x) => x.id !== c.id); task.commentCount -= 1; changed = true; renderComments(); } }) : null),
            h('div', { class: 'comment-text' }, c.body)));
      }),
      h('div', { class: 'comment-add' }, avatar(state.user, { size: 'sm' }), h('div', { class: 'grow stack', style: { gap: '6px' } }, ta, h('div', { class: 'flex', style: { justifyContent: 'flex-end' } }, h('span', { class: 'small muted grow' }, 'Ctrl+Enter to post'), button('Comment', { size: 'sm', variant: 'primary', onclick: post })))));
  }
  renderComments();

  // --- side column
  const labelsBox = h('div', { class: 'stack', style: { gap: '6px' } });
  function renderLabels() {
    const inp = input({ placeholder: 'Add label, press Enter', class: 'input' });
    inp.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const v = inp.value.trim().slice(0, 30); if (!v || task.labels.includes(v)) { inp.value = ''; return; }
      await patch({ labels: [...task.labels, v] }); renderLabels(); labelsBox.querySelector('input')?.focus();
    });
    mount(labelsBox, task.labels.length ? h('div', { class: 'chips' }, task.labels.map((l) => h('span', { class: 'chip' }, l, h('button', { type: 'button', 'aria-label': `Remove ${l}`, onclick: async () => { await patch({ labels: task.labels.filter((x) => x !== l) }); renderLabels(); } }, '×')))) : null, inp);
  }
  renderLabels();

  const sideField = (label, control) => h('div', { class: 'field' }, h('label', { class: 'field-label' }, label), control);
  const side = h('div', { class: 'task-side' },
    sideField('Status', select(STATUS_OPTIONS, { value: task.status, onchange: (e) => patch({ status: e.target.value }) })),
    sideField('Priority', select(PRIORITIES, { value: task.priority, onchange: (e) => patch({ priority: e.target.value }) })),
    sideField('Assignee', select(state.members.map((m) => ({ value: m.id, label: m.name })), { value: task.assigneeUserId || '', placeholder: 'Unassigned', onchange: (e) => patch({ assigneeUserId: e.target.value || null }) })),
    sideField('Project', select(state.projects.filter((p) => p.status !== 'archived' || p.id === task.projectId).map((p) => ({ value: p.id, label: p.name })), { value: task.projectId || '', placeholder: 'No project', onchange: (e) => patch({ projectId: e.target.value || null }) })),
    sideField('Due date', input({ type: 'date', value: task.dueDate || '', onchange: (e) => patch({ dueDate: e.target.value || null }) })),
    sideField('Labels', labelsBox),
    h('div', { class: 'small muted', style: { marginTop: '8px' } }, `Created ${date(task.createdAt)} by ${member(task.createdBy)?.name || 'a former member'}`, task.completedAt ? h('div', {}, `Completed ${date(task.completedAt)}`) : null),
    canDelete ? button('Delete task', { variant: 'danger', size: 'sm', icon: 'trash', onclick: async () => {
      const ok = await confirmDialog({ title: `Delete ${ref}?`, message: 'Comments and checklist go with it. This cannot be undone.', confirmText: 'Delete', danger: true });
      if (!ok) return;
      await api.del(`/api/tasks/${task.id}`); toast('Task deleted'); changed = true; modal.close();
    } }) : null);

  const content = h('div', { class: 'task-layout' },
    h('div', { class: 'task-main' },
      title,
      h('div', {}, h('div', { class: 'section-title', style: { margin: '0 0 8px' } }, 'Description'), descBox),
      h('div', {}, h('div', { class: 'section-title', style: { margin: '0 0 8px' } }, 'Checklist'), checklistBox),
      h('div', {}, h('div', { class: 'section-title', style: { margin: '0 0 10px' } }, `Comments (${task.comments.length})`), commentsBox)),
    side);

  const modal = openModal({ title: ref, size: 'xl', content, headerExtra: h('span', { class: 'flex', style: { gap: '10px' } }, savedHint, button('Copy link', { size: 'sm', icon: 'copy', onclick: async () => { try { await navigator.clipboard.writeText(`${location.origin}/board?task=${task.id}`); toast('Link copied'); } catch { toast('Could not copy', { type: 'error' }); } } })), onClose: () => { if (changed) onSaved?.(task); onClose?.(); } });
  modal.dialog.querySelector('.modal-title').classList.add('task-ref');
  return modal;
}

function openCreateModal(defaults, onSaved, onClose) {
  const form = h('form', { class: 'form-grid', novalidate: true },
    field({ label: 'Title', name: 'title', required: true, input: input({ class: 'input input-lg', placeholder: 'What needs to be done?', required: true, autofocus: true }) }),
    field({ label: 'Description', name: 'description', input: textarea({ rows: 4, placeholder: 'Details, links, acceptance criteria…' }) }),
    row(
      field({ label: 'Status', name: 'status', input: select(STATUS_OPTIONS, { value: defaults.status || 'todo' }) }),
      field({ label: 'Priority', name: 'priority', input: select(PRIORITIES, { value: defaults.priority || 'medium' }) })),
    row(
      field({ label: 'Assignee', name: 'assigneeUserId', input: select(state.members.map((m) => ({ value: m.id, label: m.name })), { value: defaults.assigneeUserId || '', placeholder: 'Unassigned' }) }),
      field({ label: 'Project', name: 'projectId', input: select(state.projects.filter((p) => p.status !== 'archived').map((p) => ({ value: p.id, label: p.name })), { value: defaults.projectId || '', placeholder: 'No project' }) })),
    row(
      field({ label: 'Due date', name: 'dueDate', input: input({ type: 'date', value: defaults.dueDate || '' }) }),
      field({ label: 'Labels', name: 'labels', input: input({ placeholder: 'design, urgent, v2' }), hint: 'Comma separated' })),
    formActions(h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create task')));
  handleSubmit(form, async (data) => {
    const labels = (data.labels || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
    const saved = await api.post('/api/tasks', { ...data, labels });
    toast(`Created ${state.company.key}-${saved.number}`);
    modal.close();
    onSaved?.(saved);
  });
  const modal = openModal({ title: 'New task', content: form, size: 'lg', onClose: () => onClose?.() });
  return modal;
}
