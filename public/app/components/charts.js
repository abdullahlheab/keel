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
