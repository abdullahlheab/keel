// Board analytics, the same family of charts Azure Boards draws:
//   cumulative flow  - how much work sat in each column on each day
//   burnup           - total scope against completed work, so scope creep is visible
//   velocity         - how much finished each week
//   cycle time       - how long a task took from first touch to done
// All of it is derived from task_events, which records every status change.
import { all } from '../db.js';

// The board's columns, in order. Lives here rather than in the route so the analytics service and
// the route do not import each other.
export const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'];

const DAY = 86400000;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

function daysBetween(fromDay, toDay) {
  const out = [];
  for (let t = Date.parse(`${fromDay}T00:00:00Z`); t <= Date.parse(`${toDay}T00:00:00Z`); t += DAY) out.push(isoDay(t));
  return out;
}

// The Monday of the week a date falls in, so weeks line up across the chart.
function weekStart(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7;
  return isoDay(d.getTime() - shift * DAY);
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @param companyId  which company
 * @param projectId  a project id to narrow to, `none` for unfiled work, or null for everything
 * @param days       how far back to draw, capped at two years
 */
export function boardInsights(companyId, { projectId = null, days = 30 } = {}) {
  const span = Math.min(Math.max(Number(days) || 30, 7), 730);
  let events = all('SELECT task_id, project_id, from_status, to_status, at FROM task_events WHERE company_id = ? ORDER BY at ASC', companyId);
  if (projectId === 'none') events = events.filter((e) => !e.project_id);
  else if (projectId) events = events.filter((e) => e.project_id === projectId);

  const today = isoDay(Date.now());
  const firstDay = events.length ? isoDay(events[0].at) : today;
  const windowStart = isoDay(Date.now() - (span - 1) * DAY);
  const from = firstDay > windowStart ? firstDay : windowStart;
  const timeline = daysBetween(from, today);

  // Walk the events once, keeping each task's status, and snapshot the counts at each day boundary.
  const status = new Map();       // task id -> status right now in the walk
  const createdOn = new Map();    // task id -> the day it first appeared
  const doneOn = new Map();       // task id -> the day it most recently became done
  const flow = [];
  const burnup = [];
  let cursor = 0;

  const snapshot = (day) => {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const s of status.values()) counts[s] = (counts[s] || 0) + 1;
    flow.push({ date: day, ...counts });
    burnup.push({ date: day, total: status.size, done: counts.done || 0 });
  };

  for (const day of timeline) {
    const end = `${day}T23:59:59.999Z`;
    while (cursor < events.length && events[cursor].at <= end) {
      const e = events[cursor];
      if (!status.has(e.task_id)) createdOn.set(e.task_id, isoDay(e.at));
      status.set(e.task_id, e.to_status);
      if (e.to_status === 'done') doneOn.set(e.task_id, isoDay(e.at));
      else doneOn.delete(e.task_id);
      cursor += 1;
    }
    snapshot(day);
  }

  // Velocity: tasks finished per week across the window.
  const weeks = new Map();
  for (const day of timeline) weeks.set(weekStart(day), 0);
  for (const [taskId, day] of doneOn) {
    void taskId;
    const w = weekStart(day);
    if (weeks.has(w)) weeks.set(w, weeks.get(w) + 1);
  }
  const velocity = [...weeks.entries()].map(([week, completed]) => ({ week, completed }));

  // Cycle time: first sighting to completion, for work finished inside the window.
  const cycles = [];
  for (const [taskId, day] of doneOn) {
    const started = createdOn.get(taskId);
    if (!started || day < from) continue;
    cycles.push(Math.max(0, Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${started}T00:00:00Z`)) / DAY)));
  }

  const last = flow[flow.length - 1] || {};
  const open = STATUSES.filter((s) => s !== 'done').reduce((n, s) => n + (last[s] || 0), 0);

  return {
    from,
    to: today,
    days: timeline.length,
    statuses: STATUSES,
    flow,
    burnup,
    velocity,
    cycleTime: {
      averageDays: cycles.length ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 10) / 10 : null,
      medianDays: median(cycles),
      completed: cycles.length,
    },
    totals: {
      tracked: status.size,
      open,
      done: last.done || 0,
      completedInWindow: cycles.length,
      weeklyAverage: velocity.length ? Math.round((velocity.reduce((a, v) => a + v.completed, 0) / velocity.length) * 10) / 10 : 0,
    },
  };
}
