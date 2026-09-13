// Company activity feed.
import { h, mount, relative, dateTime, date } from '../dom.js';
import { api } from '../api.js';
import { state, member } from '../state.js';
import { pageHeader, spinner, icon, avatar, button, emptyState, badge } from '../components/ui.js';
import { select } from '../components/forms.js';
import { setQuery, navigate } from '../router.js';
import { openExpenseModal } from './expenses.js';
import { toast } from '../components/toast.js';

const TYPE_ICON = { project: 'folder', expense: 'receipt', task: 'checkSquare', member: 'users', company: 'settings', category: 'tag' };
const TYPES = [['project', 'Projects'], ['expense', 'Expenses'], ['task', 'Tasks'], ['member', 'Members'], ['company', 'Company']].map(([value, label]) => ({ value, label }));

export async function render(view, ctx) {
  const q = ctx.query;
  mount(view, spinner());
  const params = new URLSearchParams({ limit: '50' });
  if (q.type) params.set('entityType', q.type);
  if (q.user) params.set('userId', q.user);
  let res = await api.get(`/api/activity?${params}`);
  const feed = h('div', { class: 'feed' });
  const more = h('div', { class: 'flex', style: { justifyContent: 'center', padding: '12px' } });
  function renderMore() {
    mount(more, res.hasMore ? button('Load older', { onclick: async () => {
      params.set('before', res.nextBefore);
      const next = await api.get(`/api/activity?${params}`);
      res = { ...next, items: [...res.items, ...next.items] };
      mount(feed, activityList(res.items));
      renderMore();
    } }) : null);
  }
  mount(feed, activityList(res.items));
  renderMore();
  mount(view,
    pageHeader({ title: 'Activity', subtitle: 'Everything that changed in the company, who did it, and when.' }),
    h('div', { class: 'filters' },
      select(TYPES, { value: q.type || '', placeholder: 'All types', onchange: (e) => setQuery({ type: e.target.value }) }),
      select(state.members.map((m) => ({ value: m.id, label: m.name })), { value: q.user || '', placeholder: 'Everyone', onchange: (e) => setQuery({ user: e.target.value }) })),
    res.items.length ? h('div', { class: 'card card-pad' }, feed, more) : emptyState({ icon: 'activity', title: 'Nothing here yet', text: 'Changes to projects, expenses, tasks and members will be recorded here.' }));
}

export function activityList(items, { compact = false } = {}) {
  const groups = [];
  for (const a of items) {
    const day = a.createdAt.slice(0, 10);
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1].items.push(a);
  }
  const todayKey = new Date().toISOString().slice(0, 10);
  const yKey = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return h('div', { class: `feed ${compact ? 'feed-compact' : ''}` }, groups.map((g) => [
    compact ? null : h('div', { class: 'feed-day' }, g.day === todayKey ? 'Today' : g.day === yKey ? 'Yesterday' : date(g.day, { weekday: 'long' })),
    g.items.map((a) => feedItem(a, compact)),
  ]));
}

function feedItem(a, compact) {
  const who = member(a.userId) || { name: a.userName || 'Someone' };
  const summary = a.summary || '';
  const name = who.name;
  const text = summary.startsWith(name) ? [h('span', { class: 'who' }, name), summary.slice(name.length)] : summary;
  const link = linkFor(a);
  const textEl = link ? h('a', { href: link, class: 'feed-text', style: { color: 'inherit' } }, text) : h('div', { class: 'feed-text' }, text);
  if (a.entityType === 'expense' && a.action !== 'deleted') {
    textEl.addEventListener('click', async (e) => {
      e.preventDefault();
      try { const exp = await api.get(`/api/expenses/${a.entityId}`); openExpenseModal({ expense: exp }); } catch { toast('That expense no longer exists', { type: 'info' }); }
    });
  }
  return h('div', { class: 'feed-item' },
    avatar(who, { size: compact ? 'xs' : 'sm' }),
    h('div', { class: 'grow', style: { minWidth: 0 } }, textEl,
      h('div', { class: 'feed-meta' }, icon(TYPE_ICON[a.entityType] || 'activity', { size: 12 }), compact ? null : badge(a.entityType), h('span', { title: dateTime(a.createdAt) }, relative(a.createdAt)))));
}

function linkFor(a) {
  if (a.action === 'deleted' || !a.entityId) return null;
  if (a.entityType === 'project') return `/projects/${a.entityId}`;
  if (a.entityType === 'task') return `/board?task=${a.entityId}`;
  if (a.entityType === 'expense') return '/expenses';
  if (a.entityType === 'member') return '/settings/members';
  return null;
}
