/**
 * Charts, drawn as plain SVG. Series colours are the traditional colours of
 * bottle glass — float green, cobalt, amber, ruby — defined in styles.css.
 */

import { h, s } from '../dom.ts';
import { bucketLabel, count, percent } from '../format.ts';

export const SERIES = ['var(--glass-green)', 'var(--glass-cobalt)', 'var(--glass-amber)', 'var(--glass-ruby)', 'var(--smoke)', 'var(--glass-teal)'];

export interface LineSeries {
  label: string;
  values: number[];
}

/** Round a step up to 1, 2 or 5 × 10^n so axis labels are whole, readable numbers. */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  return Math.max(f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10, exp < 1 ? 1 : 0) * exp;
}

function ticks(dataMax: number): number[] {
  const step = Math.max(1, niceStep(dataMax / 4));
  const out = [0];
  while (out[out.length - 1]! < dataMax) out.push(out[out.length - 1]! + step);
  if (out.length < 2) out.push(step);
  return out;
}

/** A multi-series line chart with a hover readout. */
export function lineChart(buckets: number[], series: LineSeries[], interval: string, options: { height?: number } = {}): HTMLElement {
  const W = 760;
  const H = options.height ?? 220;
  const pad = { top: 12, right: 12, bottom: 26, left: 44 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const tickValues = ticks(Math.max(0, ...series.flatMap((x) => x.values)));
  const max = tickValues[tickValues.length - 1]!;
  const x = (i: number) => pad.left + (buckets.length <= 1 ? innerW / 2 : (i / (buckets.length - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;

  const grid = tickValues.map((v) =>
    s(
      'g',
      {},
      s('line', { x1: pad.left, x2: W - pad.right, y1: y(v), y2: y(v), class: 'grid' }),
      s('text', { x: pad.left - 8, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, count(v)),
    ),
  );
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
  const xLabels = buckets.map((b, i) =>
    i % labelEvery === 0 ? s('text', { x: x(i), y: H - 6, class: 'axis', 'text-anchor': 'middle' }, bucketLabel(b, interval)) : null,
  );
  const lines = series.map((line, si) => {
    const color = SERIES[si % SERIES.length]!;
    const d = line.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = si === 0 && series.length === 1 ? s('path', { d: `${d} L${x(line.values.length - 1)},${y(0)} L${x(0)},${y(0)} Z`, fill: color, class: 'area' }) : null;
    return s('g', {}, area, s('path', { d, stroke: color, class: 'line' }));
  });

  const cursor = s('line', { y1: pad.top, y2: pad.top + innerH, class: 'cursor', visibility: 'hidden' });
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': series.map((x) => x.label).join(', ') }, ...grid, ...xLabels, ...lines, cursor);
  const readout = h('div', { class: 'readout', hidden: true });
  const legend =
    series.length > 1
      ? h('ul', { class: 'legend' }, series.map((line, i) => h('li', {}, h('span', { class: 'swatch', style: `background:${SERIES[i % SERIES.length]}` }), line.label)))
      : null;
  const wrap = h('div', { class: 'chart-wrap' }, svg, readout, legend);

  svg.addEventListener('mousemove', (event: Event) => {
    const e = event as MouseEvent;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(buckets.length - 1, Math.round(((px - pad.left) / innerW) * (buckets.length - 1))));
    cursor.setAttribute('x1', String(x(i)));
    cursor.setAttribute('x2', String(x(i)));
    cursor.setAttribute('visibility', 'visible');
    readout.hidden = false;
    readout.replaceChildren(
      h('strong', {}, bucketLabel(buckets[i] ?? 0, interval)),
      ...series.map((line, si) => h('span', {}, h('span', { class: 'swatch', style: `background:${SERIES[si % SERIES.length]}` }), `${line.label} ${count(line.values[i] ?? 0)}`)),
    );
    readout.style.left = `${(x(i) / W) * 100}%`;
  });
  svg.addEventListener('mouseleave', () => {
    cursor.setAttribute('visibility', 'hidden');
    readout.hidden = true;
  });
  return wrap;
}

export interface BarRow {
  label: string;
  value: number;
  secondary?: number;
  href?: string;
}

/** Horizontal bars behind each row, scaled to the largest value. */
export function barList(rows: BarRow[], headers: [string, string, string?]): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return h(
    'div',
    { class: 'bar-list' },
    h('div', { class: 'bar-head' }, h('span', {}, headers[0]), h('span', { class: 'num' }, headers[1]), headers[2] ? h('span', { class: 'num' }, headers[2]) : null),
    rows.map((r) =>
      h(
        'div',
        { class: 'bar-row', title: r.label },
        h('span', { class: 'bar-fill', style: `width:${(r.value / max) * 100}%` }),
        r.href ? h('a', { class: 'bar-label', href: r.href }, r.label) : h('span', { class: 'bar-label' }, r.label),
        h('span', { class: 'num' }, count(r.value)),
        r.secondary !== undefined ? h('span', { class: 'num muted' }, count(r.secondary)) : null,
      ),
    ),
  );
}

export interface FunnelStepView {
  label: string;
  count: number;
  conversionFromStart: number;
  conversionFromPrevious: number;
  avgSecondsFromPrevious: number | null;
}

export function funnelChart(steps: FunnelStepView[]): HTMLElement {
  const first = Math.max(1, steps[0]?.count ?? 1);
  return h(
    'ol',
    { class: 'funnel' },
    steps.map((step, i) =>
      h(
        'li',
        {},
        h('div', { class: 'funnel-label' }, h('span', { class: 'step-name' }, step.label), h('span', { class: 'num' }, `${count(step.count)} (${percent(step.conversionFromStart)})`)),
        h('div', { class: 'funnel-track' }, h('div', { class: 'funnel-bar', style: `width:${(step.count / first) * 100}%` })),
        i > 0
          ? h(
              'div',
              { class: 'funnel-drop muted' },
              `${percent(step.conversionFromPrevious)} of the previous step`,
              step.avgSecondsFromPrevious !== null ? `, after ${Math.round(step.avgSecondsFromPrevious)}s on average` : '',
            )
          : null,
      ),
    ),
  );
}

export interface CohortView {
  start: number;
  size: number;
  counts: number[];
  rates: number[];
}

export function retentionGrid(cohorts: CohortView[], average: number[], period: string): HTMLElement {
  const periods = average.length;
  const cell = (rate: number, n: number) =>
    h('td', { class: 'num heat', style: `--heat:${Math.round(rate * 100)}`, title: `${count(n)} people` }, percent(rate, 0));
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'retention' },
      h(
        'thead',
        {},
        h('tr', {}, h('th', {}, 'Cohort'), h('th', { class: 'num' }, 'People'), Array.from({ length: periods }, (_, k) => h('th', { class: 'num' }, `${period[0]!.toUpperCase()}${k}`))),
      ),
      h(
        'tbody',
        {},
        h('tr', { class: 'average' }, h('td', {}, 'Average'), h('td', {}, ''), average.map((r) => cell(r, 0))),
        cohorts.map((c) =>
          h(
            'tr',
            {},
            h('td', {}, bucketLabel(c.start, period === 'month' ? 'month' : 'day')),
            h('td', { class: 'num' }, count(c.size)),
            c.rates.map((r, k) => cell(r, c.counts[k] ?? 0)),
          ),
        ),
      ),
    ),
  );
}
