// Project list and the create/edit project modal.
import { h, mount, money, date, centsToInput, debounce } from '../dom.js';
import { api } from '../api.js';
import { state, currency, member, isAdmin } from '../state.js';
import { pageHeader, spinner, icon, avatar, button, emptyState, statusBadge, tabs, colorDot } from '../components/ui.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { field, input, textarea, select, moneyInput, handleSubmit, formActions, row } from '../components/forms.js';
import { toast } from '../components/toast.js';
import { meter } from '../components/charts.js';
import { navigate, setQuery } from '../router.js';

const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948', '#52514e'];
const STATUS_OPTIONS = [['planning', 'Planning'], ['active', 'Active'], ['on_hold', 'On hold'], ['completed', 'Completed'], ['archived', 'Archived']].map(([value, label]) => ({ value, label }));

export async function render(view, ctx) {
  mount(view, spinner());
  const filter = ctx.query.filter || 'active';
  const res = await api.get('/api/projects?includeArchived=1');
  const all = res.items;
  state.projects = all;
  const shown = all.filter((p) => filter === 'all' ? p.status !== 'archived' : filter === 'archived' ? p.status === 'archived' : ['active', 'planning'].includes(p.status))
    .filter((p) => !ctx.query.q || p.name.toLowerCase().includes(ctx.query.q.toLowerCase()));
  const cur = currency();

  const search = h('div', { class: 'search' }, icon('search', { size: 15 }), input({ placeholder: 'Search projects', value: ctx.query.q || '', oninput: debounce((e) => setQuery({ q: e.target.value }), 250) }));

  const grid = shown.length ? h('div', { class: 'grid grid-auto' }, shown.map((p) => projectCard(p, cur))) : emptyState({
    icon: 'folder',
    title: filter === 'archived' ? 'No archived projects' : all.length ? 'No projects match' : 'No projects yet',
    text: all.length ? 'Try another filter.' : 'Projects group tasks and expenses so you can see what each initiative costs.',
    action: all.length ? null : button('New project', { variant: 'primary', icon: 'plus', onclick: () => openProjectModal({ onSaved: ctx.refresh }) }),
  });

  mount(view,
    pageHeader({ title: 'Projects', subtitle: `${all.filter((p) => p.status !== 'archived').length} project${all.length === 1 ? '' : 's'} · ${money(all.reduce((s, p) => s + p.spentCents, 0), cur)} spent in total`, actions: [button('New project', { variant: 'primary', icon: 'plus', onclick: () => openProjectModal({ onSaved: ctx.refresh }) })] }),
    h('div', { class: 'filters' },
      h('div', { class: 'segmented' }, [['active', 'Active'], ['all', 'All'], ['archived', 'Archived']].map(([id, label]) => h('button', { class: id === filter ? 'active' : '', type: 'button', onclick: () => setQuery({ filter: id === 'active' ? null : id }) }, label))),
      h('div', { class: 'spacer' }),
      search),
    grid,
  );
}

function projectCard(p, cur) {
  const lead = p.leadUserId ? member(p.leadUserId) : null;
  const pct = p.taskTotal ? Math.round((p.taskDone / p.taskTotal) * 100) : 0;
  const card = h('a', { href: `/projects/${p.id}`, class: 'card card-link project-card' },
    h('div', { class: 'pc-head' }, h('div', { class: 'pc-name' }, p.name), statusBadge('project', p.status)),
    p.description ? h('div', { class: 'pc-desc' }, p.description) : null,
    p.budgetCents != null ? meter({ spentCents: p.spentCents, budgetCents: p.budgetCents, currency: cur, name: 'Budget', color: p.color }) : h('div', { class: 'small text-2' }, h('b', { class: 'tnum' }, money(p.spentCents, cur)), ` spent · ${p.expenseCount} expense${p.expenseCount === 1 ? '' : 's'}`),
    h('div', { class: 'pc-foot' },
      h('span', { class: 'flex', style: { gap: '6px' } }, icon('checkSquare', { size: 14 }), h('span', { class: 'progress-text' }, p.taskTotal ? `${p.taskDone}/${p.taskTotal} tasks · ${pct}%` : 'No tasks')),
      h('span', { class: 'flex', style: { gap: '6px' } }, p.endDate ? [icon('calendar', { size: 14 }), date(p.endDate)] : null, lead ? avatar(lead, { size: 'xs', title: `Lead: ${lead.name}` }) : null)));
  card.style.setProperty('--pcolor', p.color || 'var(--accent)');
  return card;
}

export function openProjectModal({ project = null, onSaved } = {}) {
  const isEdit = Boolean(project);
  let color = project?.color || COLORS[state.projects.length % COLORS.length];
  const colorField = h('div', { class: 'swatches' });
  const customColor = h('input', { type: 'color', class: 'input input-color', value: color, title: 'Custom color', oninput: (e) => { color = e.target.value; paintSwatches(); } });
  function paintSwatches() {
    mount(colorField, COLORS.map((c) => { const b = h('button', { type: 'button', class: `swatch ${c.toLowerCase() === color.toLowerCase() ? 'active' : ''}`, 'aria-label': c, onclick: () => { color = c; customColor.value = c; paintSwatches(); } }); b.style.setProperty('--sw', c); return b; }), customColor);
  }
  paintSwatches();

  const form = h('form', { class: 'form-grid', novalidate: true },
    field({ label: 'Project name', name: 'name', required: true, input: input({ value: project?.name || '', placeholder: 'e.g. Website launch', required: true, class: 'input input-lg' }) }),
    field({ label: 'Description', name: 'description', input: textarea({ value: project?.description || '', placeholder: 'What is this project about?' }) }),
    row(
      field({ label: 'Status', name: 'status', input: select(STATUS_OPTIONS, { value: project?.status || 'active' }) }),
      field({ label: 'Lead', name: 'leadUserId', input: select(state.members.map((m) => ({ value: m.id, label: m.name })), { value: project?.leadUserId || '', placeholder: 'No lead' }) })),
    row(
      field({ label: `Budget (${currency()})`, name: 'budget', input: h('div', { class: 'money-wrap' }, h('span', { class: 'cur' }, currency()), moneyInput({ value: centsToInput(project?.budgetCents), name: 'budget' })), hint: 'Optional. Used to show spending against plan.' }),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Color'), colorField)),
    row(
      field({ label: 'Start date', name: 'startDate', input: input({ type: 'date', value: project?.startDate || '' }) }),
      field({ label: 'Target end date', name: 'endDate', input: input({ type: 'date', value: project?.endDate || '' }) })),
    formActions(
      isEdit && isAdmin() ? h('button', { class: 'btn btn-danger left', type: 'button', onclick: async () => {
        const ok = await confirmDialog({ title: `Delete "${project.name}"?`, message: 'Tasks and expenses in this project are kept but become unassigned. Archiving is usually the better choice.', confirmText: 'Delete project', danger: true });
        if (!ok) return;
        await api.del(`/api/projects/${project.id}`);
        toast('Project deleted');
        modal.close(); onSaved?.(); navigate('/projects');
      } }, 'Delete') : null,
      h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, isEdit ? 'Save changes' : 'Create project')));
  // the money input inside the wrapper needs the field's name for error mapping
  form.querySelector('.money-wrap input').name = 'budget';

  handleSubmit(form, async (data) => {
    const body = { ...data, color, budget: data.budget ?? null };
    delete body.undefined;
    const saved = isEdit ? await api.patch(`/api/projects/${project.id}`, body) : await api.post('/api/projects', body);
    toast(isEdit ? 'Project updated' : 'Project created');
    const list = await api.get('/api/projects?includeArchived=1'); state.projects = list.items;
    modal.close();
    onSaved?.(saved);
    if (!isEdit && !onSaved) navigate(`/projects/${saved.id}`);
  });
  const modal = openModal({ title: isEdit ? 'Edit project' : 'New project', content: form, size: 'lg' });
  return modal;
}
