// Board analytics, drawn from /api/insights. Used on the project page and the task board.
import { h, mount, STATUS, TASK_STATUSES } from '../dom.js';
import { api } from '../api.js';
import { spinner, icon } from '../components/ui.js';
import { flowChart, burnupChart, countColumns, statTile } from '../components/charts.js';

const LABELS = Object.fromEntries(TASK_STATUSES.map((s) => [s, STATUS.task[s].label]));
const COLORS = Object.fromEntries(TASK_STATUSES.map((s) => [s, STATUS.task[s].color]));
const RANGES = [[14, '2 weeks'], [30, '30 days'], [90, '3 months'], [180, '6 months']];

const weekLabel = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Renders the charts into `host`.
 * @param projectId  narrow to a project, 'none' for unfiled work, or null for the whole company
 * @param onDays     called with a new window length when the range buttons are used
 */
export async function insightsPanel(host, { projectId = null, days = 30, onDays } = {}) {
  mount(host, spinner('Working out the numbers…'));
  const params = new URLSearchParams({ days: String(days) });
  if (projectId && projectId !== 'none') params.set('project', projectId);
  else if (projectId === 'none') params.set('project', 'none');

  let data;
  try { data = await api.get(`/api/insights?${params}`); }
  catch (err) { mount(host, h('p', { class: 'muted small' }, err.message)); return; }

  const range = h('div', { class: 'segmented' }, RANGES.map(([d, label]) =>
    h('button', { type: 'button', class: d === days ? 'active' : '', onclick: () => onDays?.(d) }, label)));

  if (!data.totals.tracked) {
    mount(host, h('div', { class: 'filters' }, h('div', { class: 'spacer' }), range),
      h('div', { class: 'card card-pad' }, h('p', { class: 'muted small' }, 'No work has been tracked in this window yet. Create a task and move it across the board, and the charts fill in from there.')));
    return;
  }

  const { cycleTime, totals } = data;
  const tiles = h('div', { class: 'grid grid-4' },
    statTile({ label: 'In flight', value: String(totals.open), hint: `${totals.tracked} tracked in total` }),
    statTile({ label: 'Completed', value: String(totals.done), hint: `${totals.completedInWindow} finished in this window` }),
    statTile({ label: 'Velocity', value: `${totals.weeklyAverage}/wk`, hint: 'Average tasks finished per week' }),
    statTile({ label: 'Cycle time', value: cycleTime.averageDays === null ? '—' : `${cycleTime.averageDays}d`, hint: cycleTime.medianDays === null ? 'Nothing finished yet' : `Median ${cycleTime.medianDays}d over ${cycleTime.completed} task${cycleTime.completed === 1 ? '' : 's'}` }));

  const card = (title, note, chart) => h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, title), note ? h('div', { class: 'small muted', style: { marginTop: '3px' } }, note) : null)),
    h('div', { class: 'card-body' }, chart));

  mount(host,
    h('div', { class: 'filters' },
      h('span', { class: 'small muted' }, `${data.from} to ${data.to}`),
      h('div', { class: 'spacer' }),
      range),
    tiles,
    h('div', { style: { height: '16px' } }),
    card('Cumulative flow', 'How much work sat in each column, day by day. A band that keeps widening is where work is piling up.',
      flowChart({ rows: data.flow, statuses: data.statuses, labels: LABELS, colors: COLORS })),
    h('div', { style: { height: '16px' } }),
    h('div', { class: 'grid grid-2' },
      card('Burnup', 'Completed against total scope. A rising scope line is work added after the plan.',
        burnupChart({ rows: data.burnup })),
      card('Velocity', 'Tasks finished each week.',
        countColumns({
          series: data.velocity,
          labelOf: (s) => weekLabel(s.week),
          valueOf: (s) => s.completed,
          tipOf: (s) => [h('b', {}, `${s.completed} finished`), h('div', { class: 'tip-sub' }, `Week of ${weekLabel(s.week)}`)],
        }))),
    h('div', { class: 'callout', style: { marginTop: '16px' } }, icon('clock'),
      h('span', {}, 'Every status change is recorded from now on. Work that moved before this feature existed shows as open from the day it was created until the day it was finished.')));
}
