// Single project: overview with spend and progress, tasks, expenses.
import { h, mount, money, date, number, STATUS } from '../dom.js';
import { api } from '../api.js';
import { state, currency, member, category, isAdmin } from '../state.js';
import { pageHeader, spinner, icon, avatar, button, emptyState, statusBadge, tabs, colorDot, menu, iconButton, kv, priorityBadge } from '../components/ui.js';
import { confirmDialog } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { columnChart, barList, meter, statTile } from '../components/charts.js';
import { openProjectModal } from './projects.js';
import { openExpenseModal, expenseTable } from './expenses.js';
import { openTaskModal, taskTable } from './board.js';
import { navigate, setQuery } from '../router.js';
import { activityList } from './activity.js';

export async function render(view, ctx) {
  mount(view, spinner());
  const id = ctx.params.id;
  const tab = ctx.query.tab || 'overview';
  const [data, activity] = await Promise.all([api.get(`/api/projects/${id}`), api.get(`/api/activity?entityType=project&entityId=${id}&limit=10`)]);
  const p = data.project;
  const cur = currency();
  const lead = p.leadUserId ? member(p.leadUserId) : null;
  const refresh = ctx.refresh;

  const actionsMenu = menu(iconButton('more', { title: 'More' }), [
    { label: 'Edit project', icon: 'edit', onclick: () => openProjectModal({ project: p, onSaved: refresh }) },
    p.status !== 'archived' ? { label: 'Archive', icon: 'inbox', onclick: () => setStatus('archived') } : { label: 'Unarchive', icon: 'refresh', onclick: () => setStatus('active') },
    p.status !== 'completed' ? { label: 'Mark completed', icon: 'check', onclick: () => setStatus('completed') } : null,
    isAdmin() ? { divider: true } : null,
    isAdmin() ? { label: 'Delete project', icon: 'trash', danger: true, onclick: async () => {
      const ok = await confirmDialog({ title: `Delete "${p.name}"?`, message: 'Tasks and expenses are kept but become unassigned.', confirmText: 'Delete', danger: true });
      if (!ok) return;
      await api.del(`/api/projects/${p.id}`); toast('Project deleted'); navigate('/projects');
    } } : null,
  ]);
  async function setStatus(status) { await api.patch(`/api/projects/${p.id}`, { status }); toast(`Project ${STATUS.project[status].label.toLowerCase()}`); refresh(); }

  const header = pageHeader({
    crumbs: [{ label: 'Projects', href: '/projects' }, { label: p.name }],
    title: [colorDot(p.color, 12), p.name, statusBadge('project', p.status)],
    subtitle: p.description || null,
    actions: [
      button('Task', { icon: 'plus', onclick: () => openTaskModal({ defaults: { projectId: p.id }, onSaved: refresh }) }),
      button('Expense', { variant: 'primary', icon: 'plus', onclick: () => openExpenseModal({ defaults: { projectId: p.id }, onSaved: refresh }) }),
      actionsMenu,
    ],
  });

  const tabBar = tabs([
    { id: 'overview', label: 'Overview' },
    { id: 'tasks', label: 'Tasks', count: data.tasks.length },
    { id: 'expenses', label: 'Expenses', count: data.expenses.length },
  ], tab, (t) => setQuery({ tab: t === 'overview' ? null : t }));

  let body;
  if (tab === 'tasks') {
    const open = data.tasks.filter((t) => t.status !== 'done');
    const done = data.tasks.filter((t) => t.status === 'done');
    body = data.tasks.length ? h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, `${open.length} open · ${done.length} done`), h('span', { class: 'flex', style: { gap: '12px' } }, h('span', { class: 'small muted hide-mobile' }, 'Ctrl+click or right-click for bulk actions'), h('a', { href: `/board?project=${p.id}`, class: 'small' }, 'Open on board'))),
      h('div', { class: 'table-wrap' }, taskTable(data.tasks, { refresh })))
      : emptyState({ icon: 'checkSquare', title: 'No tasks in this project', text: 'Add the first task to start planning.', action: button('New task', { variant: 'primary', icon: 'plus', onclick: () => openTaskModal({ defaults: { projectId: p.id }, onSaved: refresh }) }) });
  } else if (tab === 'expenses') {
    body = data.expenses.length ? h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, expenseTable(data.expenses, { onChanged: refresh, hideProject: true }))) : emptyState({ icon: 'receipt', title: 'No expenses yet', text: 'Costs logged against this project appear here.', action: button('Add expense', { variant: 'primary', icon: 'plus', onclick: () => openExpenseModal({ defaults: { projectId: p.id }, onSaved: refresh }) }) });
  } else {
    const remaining = p.budgetCents != null ? p.budgetCents - p.spentCents : null;
    const pct = p.taskTotal ? Math.round((p.taskDone / p.taskTotal) * 100) : 0;
    const months = fillMonths(data.spendByMonth);
    const catItems = data.spendByCategory.map((c) => { const cat = c.categoryId ? category(c.categoryId) : null; return { name: cat ? cat.name : 'Uncategorised', color: cat ? cat.color : 'var(--muted)', cents: c.cents, count: data.expenses.filter((e) => e.categoryId === c.categoryId).length }; });
    body = h('div', { class: 'stack', style: { gap: '16px' } },
      h('div', { class: 'grid grid-4' },
        statTile({ label: 'Spent', value: money(p.spentCents, cur), hint: `${p.expenseCount} expense${p.expenseCount === 1 ? '' : 's'}` }),
        statTile({ label: 'Budget', value: p.budgetCents != null ? money(p.budgetCents, cur) : '—', hint: p.budgetCents != null ? (remaining >= 0 ? `${money(remaining, cur)} remaining` : `${money(-remaining, cur)} over budget`) : 'No budget set', deltaKind: remaining != null && remaining < 0 ? 'bad' : '' }),
        statTile({ label: 'Tasks done', value: `${pct}%`, hint: `${p.taskDone} of ${p.taskTotal} task${p.taskTotal === 1 ? '' : 's'}` }),
        statTile({ label: 'Timeline', value: p.endDate ? date(p.endDate) : '—', hint: p.startDate ? `Started ${date(p.startDate)}` : 'No dates set' })),
      p.budgetCents != null ? h('div', { class: 'card card-pad' }, meter({ spentCents: p.spentCents, budgetCents: p.budgetCents, currency: cur, name: 'Budget used', color: p.color })) : null,
      h('div', { class: 'grid grid-23' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Spending by month')), h('div', { class: 'card-body' }, data.expenses.length ? columnChart({ series: months, currency: cur, currentKey: new Date().toISOString().slice(0, 7) }) : h('p', { class: 'muted small' }, 'No expenses logged yet.'))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'By category')), h('div', { class: 'card-body' }, barList({ items: catItems, currency: cur, emptyText: 'No expenses yet' })))),
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Details')), h('div', { class: 'card-body grid grid-2' },
          kv('Lead', lead ? h('span', { class: 'flex' }, avatar(lead, { size: 'xs' }), lead.name) : 'Unassigned'),
          kv('Status', statusBadge('project', p.status)),
          kv('Created', `${date(p.createdAt)} by ${member(p.createdBy)?.name || 'a former member'}`),
          kv('Last updated', date(p.updatedAt)))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Project history')), h('div', { class: 'card-body' }, activity.items.length ? activityList(activity.items, { compact: true }) : h('p', { class: 'muted small' }, 'No changes recorded yet.')))));
  }
  mount(view, header, tabBar, body);
}

function fillMonths(byMonth) {
  const map = Object.fromEntries(byMonth.map((m) => [m.month, m.cents]));
  const out = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const k = d.toISOString().slice(0, 7);
    out.push({ month: k, cents: map[k] || 0, count: byMonth.find((m) => m.month === k) ? 1 : 0 });
  }
  return out;
}

