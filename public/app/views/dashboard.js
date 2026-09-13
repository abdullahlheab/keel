// Home: KPIs, spend trend, budgets, task snapshot, recent activity, onboarding.
import { h, mount, money, number, todayIso, daysUntil, relative } from '../dom.js';
import { api } from '../api.js';
import { state, currency, member, isAdmin } from '../state.js';
import { pageHeader, spinner, icon, avatar, colorDot, button, emptyState, statusBadge, priorityBadge } from '../components/ui.js';
import { columnChart, barList, meter, statTile, sparkline } from '../components/charts.js';
import { openExpenseModal } from './expenses.js';
import { openTaskModal } from './board.js';
import { openProjectModal } from './projects.js';
import { activityList } from './activity.js';

export async function render(view, ctx) {
  mount(view, spinner());
  const [summary, projects, tasks, activity] = await Promise.all([
    api.get('/api/expenses/summary'),
    api.get('/api/projects'),
    api.get('/api/tasks'),
    api.get('/api/activity?limit=8'),
  ]);
  const cur = currency();
  const t = summary.totals;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = (state.user?.name || '').split(' ')[0];
  const open = tasks.items.filter((x) => x.status !== 'done');
  const today = todayIso();
  const overdue = open.filter((x) => x.dueDate && x.dueDate < today);
  const mine = open.filter((x) => x.assigneeUserId === state.user.id);
  const dueSoon = open.filter((x) => x.dueDate && daysUntil(x.dueDate) <= 7).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const active = projects.items.filter((p) => p.status === 'active');
  const isEmpty = !summary.totals.count && !projects.items.length && !tasks.items.length;

  const monthDelta = t.lastMonthCents ? ((t.thisMonthCents - t.lastMonthCents) / t.lastMonthCents) * 100 : null;
  const deltaEl = monthDelta === null
    ? (t.lastMonthCents === 0 && t.thisMonthCents > 0 ? 'No spend last month' : 'vs last month: —')
    : [icon('trendUp', { size: 13, cls: monthDelta < 0 ? 'flip' : '' }), `${monthDelta > 0 ? '+' : ''}${Math.abs(monthDelta) < 10 ? monthDelta.toFixed(1) : monthDelta.toFixed(0)}% vs last month (${money(t.lastMonthCents, cur, { compact: true })})`];

  const kpis = h('div', { class: 'grid grid-4' },
    statTile({ label: 'Spent this month', value: money(t.thisMonthCents, cur), delta: deltaEl, deltaKind: monthDelta === null || Math.abs(monthDelta) < 0.5 ? '' : (monthDelta > 0 ? 'bad' : 'good'), trend: sparkline(summary.byMonth.map((m) => m.cents)) }),
    statTile({ label: 'Spent all time', value: money(t.allTimeCents, cur), hint: `${number(t.count)} expense${t.count === 1 ? '' : 's'} · ${money(t.ytdCents, cur, { compact: true })} this year` }),
    statTile({ label: 'Monthly recurring', value: money(t.recurringMonthlyCents, cur), hint: t.pendingCount ? `${money(t.pendingCents, cur)} pending in ${t.pendingCount} expense${t.pendingCount === 1 ? '' : 's'}` : 'Subscriptions tagged as recurring' }),
    statTile({ label: 'Open tasks', value: number(open.length), delta: overdue.length ? [icon('alert', { size: 13 }), `${overdue.length} overdue`] : `${mine.length} assigned to you`, deltaKind: overdue.length ? 'bad' : '' }),
  );

  const thisMonthKey = today.slice(0, 7);
  const trendCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Spending, last 12 months'), h('a', { href: '/expenses/summary', class: 'small' }, 'Full summary')),
    h('div', { class: 'card-body' }, summary.totals.count ? columnChart({ series: summary.byMonth, currency: cur, currentKey: thisMonthKey, onSelect: (s) => { window.location.assign(`/expenses?from=${s.month}-01&to=${s.month}-31`); } }) : emptyState({ icon: 'receipt', title: 'No expenses yet', text: 'Log your first expense to start seeing trends.', action: button('Add expense', { variant: 'primary', icon: 'plus', onclick: () => openExpenseModal({ onSaved: ctx.refresh }) }) })));

  const byProjectCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Spend by project'), h('span', { class: 'small muted' }, 'all time')),
    h('div', { class: 'card-body' }, barList({ items: summary.byProject, currency: cur, sub: (i) => `${i.count} expense${i.count === 1 ? '' : 's'}`, onClick: (i) => { window.location.assign(i.projectId ? `/projects/${i.projectId}` : '/expenses?project=none'); }, emptyText: 'No expenses yet' })));

  const budgetsCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Budgets'), h('a', { href: '/projects', class: 'small' }, 'All projects')),
    h('div', { class: 'card-body stack' }, summary.budgets.length
      ? summary.budgets.sort((a, b) => (b.spentCents / b.budgetCents) - (a.spentCents / a.budgetCents)).slice(0, 6).map((b) => meter({ ...b, currency: cur, href: `/projects/${b.projectId}` }))
      : h('p', { class: 'muted small' }, active.length ? 'Set a budget on a project to track it here.' : 'Create a project with a budget to track it here.')));

  const tasksCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Coming up'), h('a', { href: '/board', class: 'small' }, 'Open board')),
    h('div', { class: 'card-body' }, dueSoon.length
      ? h('div', { class: 'stack', style: { gap: '6px' } }, dueSoon.slice(0, 7).map((task) => {
        const d = daysUntil(task.dueDate);
        const proj = state.projects.find((p) => p.id === task.projectId);
        const dueText = d < 0 ? `${-d}d overdue` : d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : `Due in ${d}d`;
        return h('a', { href: `/board?task=${task.id}`, class: 'stack', style: { gap: '2px', padding: '7px 0', color: 'inherit', borderBottom: '1px solid var(--border)' } },
          h('span', { class: 'flex' }, colorDot(proj?.color || 'var(--muted)', 8), h('span', { class: 'grow truncate', style: { fontWeight: 500 } }, task.title), task.assigneeUserId ? avatar(member(task.assigneeUserId), { size: 'xs' }) : null),
          h('span', { class: 'flex small muted', style: { gap: '10px', paddingLeft: '16px' } },
            h('span', { class: 'mono' }, `${state.company.key}-${task.number}`),
            priorityBadge(task.priority),
            h('span', { style: { color: d < 0 ? 'var(--critical-text)' : d <= 1 ? 'var(--warning-text)' : 'var(--muted)', fontWeight: d <= 1 ? 600 : 400, whiteSpace: 'nowrap', marginLeft: 'auto' } }, dueText)));
      }))
      : h('p', { class: 'muted small' }, open.length ? 'Nothing due in the next 7 days.' : 'No open tasks. Enjoy it while it lasts.')));

  const statusCounts = ['backlog', 'todo', 'in_progress', 'review', 'done'].map((s) => ({ s, n: tasks.items.filter((x) => x.status === s).length }));
  const statusStrip = h('div', { class: 'flex', style: { gap: '14px', flexWrap: 'wrap' } }, statusCounts.map(({ s, n }) => h('a', { href: `/board?status=${s}`, class: 'flex', style: { gap: '6px', color: 'inherit' } }, statusBadge('task', s), h('b', { class: 'tnum' }, n))));

  const activityCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Recent activity'), h('a', { href: '/activity', class: 'small' }, 'See all')),
    h('div', { class: 'card-body' }, activity.items.length ? activityList(activity.items, { compact: true }) : h('p', { class: 'muted small' }, 'Actions by you and your team will show up here.')));

  const onboarding = isEmpty || state.members.length < 2 ? h('div', { class: 'onboard' },
    step(1, 'Invite your co-founder', 'Send them a secure invite link.', '/settings/members', state.members.length >= 2, 'users'),
    step(2, 'Create a project', 'Group work and spending by initiative.', null, projects.items.length > 0, 'folder', () => openProjectModal({ onSaved: ctx.refresh })),
    step(3, 'Log an expense', 'Track who paid, for what, and attach the receipt.', null, summary.totals.count > 0, 'receipt', () => openExpenseModal({ onSaved: ctx.refresh })),
    step(4, 'Add a task', 'Plan the week on the board.', null, tasks.items.length > 0, 'checkSquare', () => openTaskModal({ onSaved: ctx.refresh })),
  ) : null;

  mount(view,
    pageHeader({
      title: `${greet}, ${firstName}`,
      subtitle: new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) + ` · ${active.length} active project${active.length === 1 ? '' : 's'} · ${state.members.length} member${state.members.length === 1 ? '' : 's'}`,
      actions: [
        button('Task', { icon: 'plus', onclick: () => openTaskModal({ onSaved: ctx.refresh }) }),
        button('Expense', { variant: 'primary', icon: 'plus', onclick: () => openExpenseModal({ onSaved: ctx.refresh }) }),
      ],
    }),
    onboarding,
    onboarding ? h('div', { style: { height: '18px' } }) : null,
    kpis,
    h('div', { style: { height: '16px' } }),
    h('div', { class: 'grid grid-23' }, trendCard, byProjectCard),
    h('div', { style: { height: '16px' } }),
    h('div', { class: 'grid grid-3' }, budgetsCard, h('div', { class: 'stack' }, tasksCard, h('div', { class: 'card card-pad' }, h('div', { class: 'card-title', style: { marginBottom: '10px' } }, 'Board at a glance'), statusStrip)), activityCard),
  );
}

function step(n, title, text, href, done, iconName, onclick) {
  const el = h(href ? 'a' : 'button', { class: `card onboard-step ${done ? 'done' : ''}`, href, type: href ? null : 'button', onclick: onclick || null, style: href ? null : { textAlign: 'left', cursor: 'pointer', font: 'inherit' } },
    h('div', { class: 'flex' }, h('span', { class: 'num' }, done ? icon('check', { size: 14 }) : n), icon(iconName, { size: 16, cls: 'muted' })),
    h('b', {}, title), h('p', {}, text));
  return el;
}
