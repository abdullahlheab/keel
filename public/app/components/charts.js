// Charts: thin marks, hairline grid, selective labels, hover tooltips, colors via CSS tokens.
import { h, svg, money, monthLabel, number } from '../dom.js';
import { colorDot } from './ui.js';

let tipEl = null;
export function showTip(x, y, content) {
  if (!tipEl) { tipEl = h('div', { class: 'chart-tip', role: 'tooltip' }); document.body.appendChild(tipEl); }
  tipEl.replaceChildren(...(Array.isArray(content) ? content : [content]));
  tipEl.style.left = `${x}px`;
  tipEl.style.top = `${y}px`;
  tipEl.hidden = false;
}
export function hideTip() { if (tipEl) tipEl.hidden = true; }

function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const rough = max / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const steps = [1, 2, 2.5, 5, 10];
  const step = steps.map((s) => s * pow).find((s) => s >= rough) || pow * 10;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

// Monthly columns. series: [{month:'YYYY-MM', cents, count}]
export function columnChart({ series, currency, height = 200, currentKey, onSelect }) {
  const W = 640; const padL = 52; const padR = 12; const padT = 14; const padB = 26;
  const plotW = W - padL - padR; const plotH = height - padT - padB;
  const max = Math.max(0, ...series.map((s) => s.cents));
  const ticks = niceTicks(max / 100);
  const yMax = (ticks[ticks.length - 1] || 1) * 100;
  const y = (v) => padT + plotH - (v / yMax) * plotH;
  const slot = plotW / series.length;
  const barW = Math.min(24, slot * 0.6);
  const root = svg('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img', 'aria-label': 'Spending by month' });

  for (const t of ticks) {
    const yy = y(t * 100);
    root.appendChild(svg('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, class: t === 0 ? 'baseline' : 'grid-line' }));
    root.appendChild(svg('text', { x: padL - 8, y: yy + 4, 'text-anchor': 'end' }, money(t * 100, currency, { compact: true })));
  }

  const maxIdx = series.reduce((best, s, i) => (s.cents > (series[best]?.cents ?? -1) ? i : best), -1);
  series.forEach((s, i) => {
    const cx = padL + slot * i + slot / 2;
    const hgt = s.cents > 0 ? Math.max(2, (s.cents / yMax) * plotH) : 0;
    const top = padT + plotH - hgt;
    const g = svg('g', { class: 'col-group' });
    const r = Math.min(4, hgt / 2);
    const path = hgt > 0
      ? `M${cx - barW / 2},${padT + plotH} V${top + r} Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top} H${cx + barW / 2 - r} Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r} V${padT + plotH} Z`
      : '';
    if (path) g.appendChild(svg('path', { d: path, class: `col ${s.month === currentKey ? 'current' : ''}` }));
    g.appendChild(svg('text', { x: cx, y: height - 8, 'text-anchor': 'middle' }, monthLabel(s.month)));
    if (s.cents > 0 && (i === maxIdx || s.month === currentKey) && hgt > 0) {
      g.appendChild(svg('text', { x: cx, y: top - 6, 'text-anchor': 'middle', class: 'val-label' }, money(s.cents, currency, { compact: true })));
    }
    const hit = svg('rect', { x: padL + slot * i, y: padT, width: slot, height: plotH + padB, class: 'hit' });
    hit.addEventListener('mouseenter', (e) => {
      root.querySelectorAll('.col').forEach((c) => c.classList.add('dim'));
      g.querySelector('.col')?.classList.remove('dim');
      const rect = hit.getBoundingClientRect();
      showTip(rect.left + rect.width / 2, rect.top + (hgt > 0 ? plotH - hgt : plotH) * (rect.height / (plotH + padB)), [h('b', {}, money(s.cents, currency)), h('div', { class: 'tip-sub' }, `${monthLabel(s.month, { long: true })} · ${s.count} expense${s.count === 1 ? '' : 's'}`)]);
    });
    hit.addEventListener('mouseleave', () => { root.querySelectorAll('.col').forEach((c) => c.classList.remove('dim')); hideTip(); });
    if (onSelect) { hit.style.cursor = 'pointer'; hit.addEventListener('click', () => onSelect(s)); }
    g.appendChild(hit);
    root.appendChild(g);
  });
  return h('div', { class: 'chart' }, root);
}

// Ranked horizontal bars with the entity's own color. items: [{name, color, cents, count}]
export function barList({ items, currency, max, onClick, sub, limit = 8, emptyText = 'Nothing yet' }) {
  if (!items.length) return h('p', { class: 'muted small' }, emptyText);
  const shown = items.slice(0, limit);
  const top = max ?? Math.max(...shown.map((i) => Math.abs(i.cents)), 1);
  const rest = items.slice(limit);
  const list = h('div', { class: 'bar-list' });
  for (const it of shown) {
    const row = h('div', { class: `bar-row ${onClick ? 'clickable' : ''}`, onclick: onClick ? () => onClick(it) : null },
      h('div', { class: 'bar-label' }, colorDot(it.color), h('span', { title: it.name }, it.name)),
      h('div', {}, h('div', { class: 'bar-value' }, money(it.cents, currency)), sub ? h('div', { class: 'bar-sub' }, sub(it)) : null),
      h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${Math.max(1, (Math.abs(it.cents) / top) * 100)}%`, '--fill': it.color || 'var(--s1)' } })));
    list.appendChild(row);
  }
  if (rest.length) {
    const restCents = rest.reduce((s, i) => s + i.cents, 0);
    list.appendChild(h('div', { class: 'bar-row' }, h('div', { class: 'bar-label' }, colorDot('var(--muted)'), h('span', {}, `Other (${rest.length})`)), h('div', { class: 'bar-value' }, money(restCents, currency))));
  }
  return list;
}

// Single 100% stacked bar with legend; folds the tail past 6 into "Other".
export function shareBar({ items, currency, limit = 6 }) {
  const total = items.reduce((s, i) => s + Math.max(0, i.cents), 0);
  if (!total) return h('p', { class: 'muted small' }, 'Nothing yet');
  const shown = items.slice(0, limit).filter((i) => i.cents > 0);
  const rest = items.slice(limit).reduce((s, i) => s + Math.max(0, i.cents), 0);
  const segs = [...shown, ...(rest > 0 ? [{ name: 'Other', color: 'var(--muted)', cents: rest }] : [])];
  const bar = h('div', { class: 'stacked', role: 'img', 'aria-label': 'Share of spending' });
  const legend = h('div', { class: 'legend' });
  for (const s of segs) {
    const pct = (s.cents / total) * 100;
    const seg = h('span', { style: { width: `${pct}%`, '--fill': s.color || 'var(--s1)' }, title: `${s.name}: ${money(s.cents, currency)} (${pct.toFixed(0)}%)` });
    seg.addEventListener('mouseenter', () => { const r = seg.getBoundingClientRect(); showTip(r.left + r.width / 2, r.top, [h('b', {}, s.name), h('div', { class: 'tip-sub' }, `${money(s.cents, currency)} · ${pct.toFixed(1)}%`)]); });
    seg.addEventListener('mouseleave', hideTip);
    bar.appendChild(seg);
    legend.appendChild(h('span', { class: 'legend-item' }, colorDot(s.color || 'var(--s1)', 8), s.name, h('b', {}, `${pct.toFixed(0)}%`)));
  }
  return h('div', {}, bar, legend);
}

// Budget meter: fill severity by utilisation, track is the lighter step of the same ramp.
export function meter({ spentCents, budgetCents, currency, name, color, href }) {
  const pct = budgetCents > 0 ? (spentCents / budgetCents) * 100 : 0;
  const cls = pct > 100 ? 'over' : pct >= 80 ? 'warn' : '';
  const remaining = budgetCents - spentCents;
  const nameEl = href ? h('a', { href, class: 'name' }, colorDot(color), h('span', { class: 'truncate' }, name)) : h('span', { class: 'name' }, colorDot(color), h('span', { class: 'truncate' }, name));
  return h('div', { class: 'meter-row' },
    h('div', { class: 'meter-head' }, nameEl, h('span', { class: 'pct' }, `${money(spentCents, currency, { compact: true })} / ${money(budgetCents, currency, { compact: true })} · ${pct.toFixed(0)}%`)),
    h('div', { class: `meter ${cls}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': budgetCents, 'aria-valuenow': spentCents, title: remaining >= 0 ? `${money(remaining, currency)} remaining` : `${money(-remaining, currency)} over budget` },
      h('div', { class: 'meter-fill', style: { width: `${Math.min(100, pct)}%` } })));
}

// ---------- board analytics (the Azure Boards family) ----------
const dayLabel = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// Picks roughly `count` evenly spaced indices, always including the last one.
function tickIndices(len, count = 6) {
  if (len <= count) return [...Array(len).keys()];
  const step = (len - 1) / (count - 1);
  return [...new Set([...Array(count).keys()].map((i) => Math.round(i * step)))];
}

function axes(root, { padL, padR, padT, plotW, plotH, yMax, W, height, rows, labelOf }) {
  for (const t of niceTicks(yMax)) {
    const yy = padT + plotH - (t / (yMax || 1)) * plotH;
    root.appendChild(svg('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, class: t === 0 ? 'baseline' : 'grid-line' }));
    root.appendChild(svg('text', { x: padL - 8, y: yy + 4, 'text-anchor': 'end' }, number(t)));
  }
  for (const i of tickIndices(rows.length)) {
    const x = padL + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
    root.appendChild(svg('text', { x, y: height - 8, 'text-anchor': i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle' }, labelOf(rows[i])));
  }
}

// Cumulative flow: one band per column, stacked, oldest status at the bottom.
// The width of a band is the amount of work sitting in that column on that day.
export function flowChart({ rows, statuses, labels, colors, height = 230 }) {
  const W = 680; const padL = 44; const padR = 12; const padT = 12; const padB = 26;
  const plotW = W - padL - padR; const plotH = height - padT - padB;
  const yMax = Math.max(1, ...rows.map((r) => statuses.reduce((n, s) => n + (r[s] || 0), 0)));
  const x = (i) => padL + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / yMax) * plotH;
  const root = svg('svg', { viewBox: `0 0 ${W} ${height}`, class: 'flow', role: 'img', 'aria-label': 'Cumulative flow' });
  axes(root, { padL, padR, padT, plotW, plotH, yMax, W, height, rows, labelOf: (r) => dayLabel(r.date) });

  // Stack from the bottom up, keeping a running total per day.
  const running = rows.map(() => 0);
  for (const s of statuses) {
    const lower = [...running];
    rows.forEach((r, i) => { running[i] += r[s] || 0; });
    if (running.every((v, i) => v === lower[i])) continue; // band is empty throughout
    const top = rows.map((_, i) => `${x(i).toFixed(1)},${y(running[i]).toFixed(1)}`);
    const bottom = rows.map((_, i) => `${x(i).toFixed(1)},${y(lower[i]).toFixed(1)}`).reverse();
    // An object style goes through the CSSOM; a style string would be an inline style attribute,
    // which the Content-Security-Policy blocks.
    root.appendChild(svg('polygon', { points: [...top, ...bottom].join(' '), class: 'flow-band', style: { '--fill': colors[s] } }));
  }

  const legend = h('div', { class: 'legend' }, statuses.map((s) => h('span', { class: 'legend-item' }, colorDot(colors[s], 8), labels[s])));
  const hover = svg('line', { class: 'cursor-line', y1: padT, y2: padT + plotH, x1: 0, x2: 0, hidden: true });
  root.appendChild(hover);
  const hit = svg('rect', { x: padL, y: padT, width: plotW, height: plotH, class: 'hit' });
  hit.addEventListener('mousemove', (e) => {
    const box = root.getBoundingClientRect();
    const i = Math.round(((e.clientX - box.left) / box.width * W - padL) / (plotW || 1) * (rows.length - 1));
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!r) return;
    hover.setAttribute('x1', x(rows.indexOf(r))); hover.setAttribute('x2', x(rows.indexOf(r))); hover.hidden = false;
    showTip(e.clientX, box.top + 8, [h('b', {}, dayLabel(r.date)),
      ...statuses.filter((s) => r[s]).reverse().map((s) => h('div', { class: 'tip-sub' }, `${labels[s]}: ${r[s]}`))]);
  });
  hit.addEventListener('mouseleave', () => { hover.hidden = true; hideTip(); });
  root.appendChild(hit);
  return h('div', { class: 'chart' }, root, legend);
}

// Burnup: total scope against completed work. The gap between the lines is what is left, and a
// rising scope line is the thing a burndown hides.
export function burnupChart({ rows, height = 200 }) {
  const W = 680; const padL = 44; const padR = 12; const padT = 12; const padB = 26;
  const plotW = W - padL - padR; const plotH = height - padT - padB;
  const yMax = Math.max(1, ...rows.map((r) => r.total));
  const x = (i) => padL + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / yMax) * plotH;
  const root = svg('svg', { viewBox: `0 0 ${W} ${height}`, class: 'burnup', role: 'img', 'aria-label': 'Burnup' });
  axes(root, { padL, padR, padT, plotW, plotH, yMax, W, height, rows, labelOf: (r) => dayLabel(r.date) });

  const line = (key, cls) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ');
  root.appendChild(svg('polygon', {
    class: 'burnup-gap',
    points: [...rows.map((r, i) => `${x(i).toFixed(1)},${y(r.total).toFixed(1)}`), ...rows.map((r, i) => `${x(i).toFixed(1)},${y(r.done).toFixed(1)}`).reverse()].join(' '),
  }));
  root.appendChild(svg('path', { d: line('total'), class: 'line line-scope' }));
  root.appendChild(svg('path', { d: line('done'), class: 'line line-done' }));

  const hover = svg('line', { class: 'cursor-line', y1: padT, y2: padT + plotH, x1: 0, x2: 0, hidden: true });
  root.appendChild(hover);
  const hit = svg('rect', { x: padL, y: padT, width: plotW, height: plotH, class: 'hit' });
  hit.addEventListener('mousemove', (e) => {
    const box = root.getBoundingClientRect();
    const idx = Math.max(0, Math.min(rows.length - 1, Math.round(((e.clientX - box.left) / box.width * W - padL) / (plotW || 1) * (rows.length - 1))));
    const r = rows[idx];
    if (!r) return;
    hover.setAttribute('x1', x(idx)); hover.setAttribute('x2', x(idx)); hover.hidden = false;
    showTip(e.clientX, box.top + 8, [h('b', {}, dayLabel(r.date)), h('div', { class: 'tip-sub' }, `Scope: ${r.total}`), h('div', { class: 'tip-sub' }, `Done: ${r.done}`), h('div', { class: 'tip-sub' }, `Remaining: ${r.total - r.done}`)]);
  });
  hit.addEventListener('mouseleave', () => { hover.hidden = true; hideTip(); });
  root.appendChild(hit);
  return h('div', { class: 'chart' }, root,
    h('div', { class: 'legend' }, h('span', { class: 'legend-item' }, colorDot('var(--s1)', 8), 'Scope'), h('span', { class: 'legend-item' }, colorDot('var(--good)', 8), 'Done')));
}

// Plain counted columns, for velocity. The money version above is a different beast.
export function countColumns({ series, labelOf, valueOf = (s) => s.count, height = 170, tipOf }) {
  const W = 680; const padL = 40; const padR = 12; const padT = 14; const padB = 26;
  const plotW = W - padL - padR; const plotH = height - padT - padB;
  const max = Math.max(1, ...series.map(valueOf));
  const ticks = niceTicks(max, 3);
  const yMax = ticks[ticks.length - 1] || 1;
  const y = (v) => padT + plotH - (v / yMax) * plotH;
  const slot = plotW / Math.max(1, series.length);
  const barW = Math.min(28, slot * 0.62);
  const root = svg('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img', 'aria-label': 'Completed per week' });
  for (const t of ticks) {
    const yy = y(t);
    root.appendChild(svg('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, class: t === 0 ? 'baseline' : 'grid-line' }));
    root.appendChild(svg('text', { x: padL - 8, y: yy + 4, 'text-anchor': 'end' }, number(t)));
  }
  series.forEach((s, i) => {
    const v = valueOf(s);
    const cx = padL + slot * i + slot / 2;
    const hgt = v > 0 ? Math.max(2, (v / yMax) * plotH) : 0;
    const top = padT + plotH - hgt;
    const g = svg('g', { class: 'col-group' });
    if (hgt > 0) {
      const r = Math.min(4, hgt / 2);
      g.appendChild(svg('path', { class: 'col', d: `M${cx - barW / 2},${padT + plotH} V${top + r} Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top} H${cx + barW / 2 - r} Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r} V${padT + plotH} Z` }));
      g.appendChild(svg('text', { x: cx, y: top - 5, 'text-anchor': 'middle', class: 'val-label' }, String(v)));
    }
    if (series.length <= 14 || i % 2 === 0) g.appendChild(svg('text', { x: cx, y: height - 8, 'text-anchor': 'middle' }, labelOf(s)));
    const hit = svg('rect', { x: padL + slot * i, y: padT, width: slot, height: plotH + padB, class: 'hit' });
    hit.addEventListener('mouseenter', () => {
      const rect = hit.getBoundingClientRect();
      showTip(rect.left + rect.width / 2, rect.top, tipOf ? tipOf(s) : [h('b', {}, String(v))]);
    });
    hit.addEventListener('mouseleave', hideTip);
    g.appendChild(hit);
    root.appendChild(g);
  });
  return h('div', { class: 'chart' }, root);
}

export function sparkline(values, { width = 96, height = 28 } = {}) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = values.length > 1 ? (width - 6) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [3 + i * stepX, 3 + (height - 6) - ((v - min) / range) * (height - 6)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return svg('svg', { class: 'sparkline', width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' },
    svg('path', { d }),
    last ? svg('circle', { cx: last[0], cy: last[1], r: 3.5, class: 'cur' }) : null);
}

export function statTile({ label, value, delta, deltaKind, hint, trend, icon: iconEl, hero = false }) {
  return h('div', { class: 'card stat' },
    h('div', { class: 'stat-label' }, iconEl || null, label),
    h('div', { class: `stat-value ${hero ? 'hero' : ''}` }, value),
    delta !== undefined && delta !== null ? h('div', { class: `stat-delta ${deltaKind || ''}` }, delta) : null,
    hint ? h('div', { class: 'stat-delta' }, hint) : null,
    trend ? h('div', { class: 'stat-foot' }, trend) : null);
}

export function pctChange(curr, prev) {
  if (!prev) return null;
  return ((curr - prev) / prev) * 100;
}

export function formatCount(n, singular, plural = `${singular}s`) { return `${number(n)} ${n === 1 ? singular : plural}`; }
