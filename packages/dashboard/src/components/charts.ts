/**
 * Charts, drawn as plain SVG at the container's real pixel width (so text and
 * strokes stay crisp at any size). Series colours are the traditional colours
 * of bottle glass — float green, cobalt, amber, ruby — defined in styles.css.
 */

import { addMonths } from '@dataflare/core/time';
import { type Child, h, mount, s } from '../dom.ts';
import { bucketLabel, count, duration, percent } from '../format.ts';
import { href } from '../state.ts';
import { icon } from './icons.ts';

export const SERIES = [
  'var(--glass-green)',
  'var(--glass-cobalt)',
  'var(--glass-amber)',
  'var(--glass-ruby)',
  'var(--glass-teal)',
  'var(--smoke)',
];

let chartIds = 0;

export interface LineSeries {
  label: string;
  values: number[];
  /** The same series over the previous period, drawn dashed. Aligned by index. */
  previous?: number[];
  /** A fitted trend, drawn as a thin dashed line in the series colour. */
  trend?: number[];
  /** How to print this line's values (e.g. a percent formula); the chart's format otherwise. */
  format?: (n: number) => string;
}

/** A note pinned to a moment, shown as a marker on time charts. */
export interface Annotation {
  /** Epoch ms. */
  at: number;
  text: string;
}

export type ChartType = 'line' | 'area' | 'bar';

export interface ChartOptions {
  height?: number;
  type?: ChartType;
  /** X labels to use instead of formatting `buckets`. */
  labels?: string[];
  /** Format for axis ticks and the tooltip. Default: counts. */
  format?: (n: number) => string;
  /** Fixed top of the y axis (e.g. 1 for rates). */
  yMax?: number;
  /** Hide the legend even with several series. */
  legend?: boolean;
  /** Logarithmic y axis, in powers of ten. */
  logScale?: boolean;
  /** Stack the series as shares of each bucket's total (areas, or bars with `type: 'bar'`). */
  percentStack?: boolean;
  /** Write each value on the chart, when there is room. */
  showValues?: boolean;
  /** Notes pinned to moments: a marker on the x axis and a line in the hover readout. */
  annotations?: Annotation[];
}

const INTERVAL_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 31 * 86_400_000,
};

/** The bucket a moment falls in, or null when it is outside the chart. */
function bucketIndex(buckets: number[], at: number, interval: string): number | null {
  if (!buckets.length || at < buckets[0]!) return null;
  let i = buckets.length - 1;
  while (i > 0 && buckets[i]! > at) i--;
  if (i === buckets.length - 1 && at >= buckets[i]! + (INTERVAL_MS[interval] ?? 86_400_000))
    return null;
  return i;
}

/** Powers of ten from 1 up to just above `dataMax`. */
function logTicks(dataMax: number): number[] {
  const top = Math.max(1, Math.ceil(Math.log10(Math.max(10, dataMax))));
  return Array.from({ length: top + 1 }, (_, k) => 10 ** k);
}

/** Round a step up to 1, 2 or 5 × 10^n so axis labels are whole, readable numbers. */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

function ticks(dataMax: number, fixedMax?: number): number[] {
  if (fixedMax) return [0, 0.25, 0.5, 0.75, 1].map((t) => t * fixedMax);
  const step = dataMax <= 4 ? 1 : niceStep(dataMax / 4);
  const out = [0];
  while (out[out.length - 1]! < dataMax) out.push(out[out.length - 1]! + step);
  if (out.length < 2) out.push(step);
  return out;
}

/** Re-render `draw(width)` whenever the element's width changes. */
function responsive(wrap: HTMLElement, draw: (width: number) => void, initial = 760): void {
  let last = 0;
  const run = (w: number) => {
    const width = Math.round(w);
    if (width < 40 || width === last) return;
    last = width;
    draw(width);
  };
  run(initial);
  if (typeof ResizeObserver !== 'undefined') {
    let frame = 0;
    new ResizeObserver((entries) => {
      cancelAnimationFrame(frame);
      const w = entries[0]?.contentRect.width ?? 0;
      frame = requestAnimationFrame(() => run(w));
    }).observe(wrap);
  }
}

function changeText(now: number, before: number): Child {
  if (!before) return null;
  const c = (now - before) / before;
  const cls = Math.abs(c) < 0.005 ? '' : c > 0 ? 'good' : 'bad';
  return h(
    'span',
    { class: `delta ${cls}` },
    `${c >= 0 ? '+' : '−'}${Math.abs(c * 100).toFixed(0)}%`,
  );
}

/** A multi-series time chart (line, area or bars) with a hover readout and optional previous-period overlay. */
export function lineChart(
  buckets: number[],
  series: LineSeries[],
  interval: string,
  options: ChartOptions = {},
): HTMLElement {
  const H = options.height ?? 260;
  const type = options.type ?? 'line';
  const fmt = options.format ?? count;
  const n = Math.max(
    buckets.length,
    options.labels?.length ?? 0,
    ...series.map((x) => x.values.length),
  );
  const label = (i: number) => options.labels?.[i] ?? bucketLabel(buckets[i] ?? 0, interval);
  const id = `c${++chartIds}`;
  const hasPrevious = series.some((x) => x.previous?.length);

  const holder = h('div', { class: 'chart-canvas' });
  const readout = h('div', { class: 'readout', hidden: true });
  const legendItems = series.map((line, i) =>
    h(
      'li',
      {},
      h('span', { class: 'swatch', style: `background:${SERIES[i % SERIES.length]}` }),
      line.label,
    ),
  );
  if (hasPrevious)
    legendItems.push(
      h(
        'li',
        { class: 'legend-previous' },
        h('span', { class: 'swatch dashed' }),
        'Previous period',
      ),
    );
  const legend =
    (options.legend ?? true) && (series.length > 1 || hasPrevious)
      ? h('ul', { class: 'legend' }, legendItems)
      : null;
  const wrap = h('div', { class: `chart-wrap chart-${type}` }, holder, readout, legend);

  // 100% stacks: each series' share of the bucket's total, and the band it fills.
  const stacked = Boolean(options.percentStack) && series.length > 1;
  const totals = Array.from({ length: n }, (_, i) =>
    series.reduce((sum, l) => sum + Math.max(0, l.values[i] ?? 0), 0),
  );
  const shares = series.map((l) =>
    Array.from({ length: n }, (_, i) =>
      totals[i] ? Math.max(0, l.values[i] ?? 0) / totals[i]! : 0,
    ),
  );
  const lower = shares.map((_, si) =>
    Array.from({ length: n }, (_, i) => shares.slice(0, si).reduce((sum, sh) => sum + sh[i]!, 0)),
  );
  const upper = lower.map((lo, si) => lo.map((v, i) => v + shares[si]![i]!));
  const log = Boolean(options.logScale) && !stacked;
  const axisFmt = stacked ? (v: number) => percent(v, 0) : fmt;
  const notesAt = new Map<number, Annotation[]>();
  for (const a of options.annotations ?? []) {
    const i = bucketIndex(buckets, a.at, interval);
    if (i !== null) notesAt.set(i, [...(notesAt.get(i) ?? []), a]);
  }

  const draw = (W: number) => {
    const all = series.flatMap((x) => [...x.values, ...(x.previous ?? []), ...(x.trend ?? [])]);
    const dataMax = Math.max(0, ...all);
    const tickValues = stacked
      ? [0, 0.25, 0.5, 0.75, 1]
      : log
        ? logTicks(dataMax)
        : ticks(dataMax, options.yMax);
    const max = tickValues[tickValues.length - 1]! || 1;
    const longest = Math.max(...tickValues.map((t) => axisFmt(t).length));
    const pad = { top: 14, right: 16, bottom: 28, left: Math.max(32, longest * 7 + 14) };
    const innerW = Math.max(10, W - pad.left - pad.right);
    const innerH = H - pad.top - pad.bottom;
    const band = innerW / Math.max(1, n);
    const x = (i: number) =>
      type === 'bar'
        ? pad.left + band * (i + 0.5)
        : pad.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = (v: number) =>
      log
        ? pad.top + innerH - (Math.log10(Math.max(1, Math.min(v, max))) / Math.log10(max)) * innerH
        : pad.top + innerH - (Math.min(v, max) / max) * innerH;

    const defs = s(
      'defs',
      {},
      series.map((_, si) =>
        s(
          'linearGradient',
          { id: `${id}-g${si}`, x1: 0, x2: 0, y1: 0, y2: 1 },
          s('stop', {
            offset: '0%',
            'stop-color': SERIES[si % SERIES.length],
            'stop-opacity': si === 0 ? 0.22 : 0.12,
          }),
          s('stop', {
            offset: '100%',
            'stop-color': SERIES[si % SERIES.length],
            'stop-opacity': 0,
          }),
        ),
      ),
    );
    const grid = tickValues.map((v, i) =>
      s(
        'g',
        {},
        s('line', {
          x1: pad.left,
          x2: W - pad.right,
          y1: y(v),
          y2: y(v),
          class: i === 0 ? 'grid baseline' : 'grid',
        }),
        s(
          'text',
          { x: pad.left - 10, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' },
          axisFmt(v),
        ),
      ),
    );
    const maxLabels = Math.max(2, Math.floor(innerW / 72));
    const every = Math.max(1, Math.ceil(n / maxLabels));
    const xLabels = Array.from({ length: n }, (_, i) =>
      i % every === 0 || (type !== 'bar' && i === n - 1 && (n - 1) % every > every / 2)
        ? s(
            'text',
            {
              x: x(i),
              y: H - 8,
              class: 'axis',
              'text-anchor':
                type === 'bar' ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
            },
            label(i),
          )
        : null,
    );

    const marks: SVGElement[] = [];
    const labels: SVGElement[] = [];
    const roomy = innerW / Math.max(1, n) >= 30;
    const valueLabel = (cx: number, cy: number, text: string) =>
      labels.push(s('text', { x: cx, y: cy, class: 'value-label', 'text-anchor': 'middle' }, text));
    if (stacked) {
      series.forEach((_, si) => {
        const color = SERIES[si % SERIES.length]!;
        if (type === 'bar') {
          const bw = Math.max(2, Math.min(40, band * 0.72));
          for (let i = 0; i < n; i++) {
            const top = y(upper[si]![i]!);
            const bottom = y(lower[si]![i]!);
            marks.push(
              s('rect', {
                x: x(i) - bw / 2,
                y: top,
                width: bw,
                height: Math.max(0, bottom - top),
                fill: color,
                class: 'bar',
              }),
            );
          }
        } else {
          const top = upper[si]!.map(
            (v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`,
          );
          const bottom = lower[si]!.map(
            (v, i) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`,
          ).reverse();
          marks.push(
            s('path', {
              d: `${top.join(' ')} ${bottom.join(' ')} Z`,
              fill: color,
              class: 'area stacked',
            }),
          );
          marks.push(s('path', { d: top.join(' '), stroke: color, class: 'line' }));
        }
        if (options.showValues && roomy)
          for (let i = 0; i < n; i++) {
            const top = y(upper[si]![i]!);
            const bottom = y(lower[si]![i]!);
            if (bottom - top >= 16)
              valueLabel(x(i), (top + bottom) / 2 + 4, percent(shares[si]![i]!, 0));
          }
      });
    } else if (type === 'bar') {
      const groups = series.length;
      const bw = Math.max(2, Math.min(32, (band * 0.72) / groups));
      series.forEach((line, si) => {
        const color = SERIES[si % SERIES.length]!;
        line.values.forEach((v, i) => {
          const bx = x(i) - (bw * groups) / 2 + si * bw;
          const top = y(v);
          if (line.previous) {
            const pv = line.previous[i] ?? 0;
            marks.push(
              s('rect', {
                x: bx + 0.5,
                y: y(pv),
                width: Math.max(1, bw - 1),
                height: Math.max(0, y(0) - y(pv)),
                class: 'bar-previous',
                stroke: color,
              }),
            );
          }
          marks.push(
            s('rect', {
              x: bx + 0.5,
              y: top,
              width: Math.max(1, bw - 1),
              height: Math.max(0, y(0) - top),
              rx: Math.min(3, bw / 3),
              fill: color,
              class: 'bar',
            }),
          );
          if (options.showValues && roomy && n * groups <= 120)
            valueLabel(bx + bw / 2, top - 5, (line.format ?? fmt)(v));
        });
        if (line.trend)
          marks.push(
            s('path', {
              d: line.trend
                .map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
                .join(' '),
              stroke: color,
              class: 'line trend',
            }),
          );
      });
    } else {
      series.forEach((line, si) => {
        const color = SERIES[si % SERIES.length]!;
        const path = (values: number[]) =>
          values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
        if (line.previous?.length)
          marks.push(
            s('path', {
              d: path(line.previous.slice(0, n)),
              stroke: color,
              class: 'line previous',
            }),
          );
        const d = path(line.values);
        const fill = type === 'area' || (si === 0 && series.length === 1);
        if (fill && line.values.length > 1) {
          marks.push(
            s('path', {
              d: `${d} L${x(line.values.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`,
              fill: `url(#${id}-g${si})`,
              class: 'area',
            }),
          );
        }
        marks.push(s('path', { d, stroke: color, class: 'line' }));
        if (line.trend?.length)
          marks.push(s('path', { d: path(line.trend), stroke: color, class: 'line trend' }));
        if (n <= 1)
          marks.push(s('circle', { cx: x(0), cy: y(line.values[0] ?? 0), r: 4, fill: color }));
        if (options.showValues && roomy && n * series.length <= 120)
          line.values.forEach((v, i) => {
            valueLabel(x(i), y(v) - 8, (line.format ?? fmt)(v));
          });
      });
    }
    const notes = [...notesAt.entries()].map(([i, list]) =>
      s(
        'g',
        { class: 'annotation' },
        s('line', {
          x1: x(i),
          x2: x(i),
          y1: pad.top,
          y2: pad.top + innerH,
          class: 'annotation-line',
        }),
        s(
          'circle',
          { cx: x(i), cy: pad.top + innerH, r: 4.5, class: 'annotation-dot' },
          s('title', {}, list.map((a) => a.text).join('\n')),
        ),
      ),
    );

    const cursor = s('line', {
      y1: pad.top,
      y2: pad.top + innerH,
      class: 'cursor',
      visibility: 'hidden',
    });
    const dots = series.map((_, si) =>
      s('circle', {
        r: 4,
        class: 'dot',
        fill: 'var(--surface)',
        stroke: SERIES[si % SERIES.length],
        visibility: 'hidden',
      }),
    );
    const hit = s('rect', { x: pad.left, y: pad.top, width: innerW, height: innerH, class: 'hit' });
    const svg = s(
      'svg',
      {
        viewBox: `0 0 ${W} ${H}`,
        width: W,
        height: H,
        class: 'chart',
        role: 'img',
        'aria-label': series.map((x) => x.label).join(', '),
      },
      defs,
      ...grid,
      ...xLabels,
      ...marks,
      ...labels,
      cursor,
      ...dots,
      hit,
      ...notes,
    );

    const show = (px: number) => {
      const i =
        type === 'bar'
          ? Math.max(0, Math.min(n - 1, Math.floor((px - pad.left) / band)))
          : Math.max(0, Math.min(n - 1, Math.round(((px - pad.left) / innerW) * (n - 1))));
      const cx = x(i);
      cursor.setAttribute('x1', String(cx));
      cursor.setAttribute('x2', String(cx));
      cursor.setAttribute('visibility', 'visible');
      if (type !== 'bar') {
        dots.forEach((dot, si) => {
          dot.setAttribute('cx', String(cx));
          dot.setAttribute(
            'cy',
            String(stacked ? y(upper[si]![i]!) : y(series[si]!.values[i] ?? 0)),
          );
          dot.setAttribute('visibility', 'visible');
        });
      }
      readout.hidden = false;
      mount(
        readout,
        h('strong', {}, label(i)),
        ...series.map((line, si) =>
          h(
            'span',
            { class: 'readout-row' },
            h('span', { class: 'swatch', style: `background:${SERIES[si % SERIES.length]}` }),
            h('span', { class: 'readout-label' }, line.label),
            h(
              'span',
              { class: 'readout-value' },
              stacked
                ? `${percent(shares[si]![i]!, 0)} · ${(line.format ?? fmt)(line.values[i] ?? 0)}`
                : (line.format ?? fmt)(line.values[i] ?? 0),
            ),
            line.previous ? changeText(line.values[i] ?? 0, line.previous[i] ?? 0) : null,
          ),
        ),
        ...(notesAt.get(i) ?? []).map((a) =>
          h(
            'span',
            { class: 'readout-note' },
            h('span', { class: 'note-icon' }, icon('flag', 12)),
            a.text,
          ),
        ),
        hasPrevious
          ? h(
              'span',
              { class: 'readout-prev muted' },
              `Previous: ${series.map((l) => (l.previous ? (l.format ?? fmt)(l.previous[i] ?? 0) : '–')).join(' · ')}`,
            )
          : null,
      );
      const flip = cx > W * 0.62;
      readout.style.left = `${cx}px`;
      readout.style.transform = flip ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)';
    };
    const hide = () => {
      cursor.setAttribute('visibility', 'hidden');
      for (const d of dots) d.setAttribute('visibility', 'hidden');
      readout.hidden = true;
    };
    svg.addEventListener('mousemove', (event: Event) => {
      const e = event as MouseEvent;
      const rect = svg.getBoundingClientRect();
      show(((e.clientX - rect.left) / rect.width) * W);
    });
    svg.addEventListener('mouseleave', hide);
    holder.replaceChildren(svg);
  };

  responsive(wrap, draw);
  return wrap;
}

/** A tiny trend line with a soft fill, for KPI tiles and cards. */
export function sparkline(
  values: number[],
  options: { color?: string; height?: number; previous?: number[] } = {},
): SVGElement {
  const H = options.height ?? 36;
  const W = 120;
  const color = options.color ?? SERIES[0]!;
  const max = Math.max(1, ...values, ...(options.previous ?? []));
  const n = values.length;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => 2 + (H - 4) - (v / max) * (H - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const id = `s${++chartIds}`;
  return s(
    'svg',
    {
      class: 'sparkline',
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
    },
    s(
      'defs',
      {},
      s(
        'linearGradient',
        { id, x1: 0, x2: 0, y1: 0, y2: 1 },
        s('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.25 }),
        s('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }),
      ),
    ),
    options.previous?.length
      ? s('path', {
          d: options.previous
            .slice(0, n)
            .map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
            .join(' '),
          class: 'spark-previous',
          stroke: color,
        })
      : null,
    n > 1 ? s('path', { d: `${d} L${W},${H} L0,${H} Z`, fill: `url(#${id})` }) : null,
    s('path', { d, stroke: color, class: 'spark-line' }),
  );
}

export interface BarRow {
  label: string;
  value: number;
  secondary?: number;
  href?: string;
}

export interface BarListOptions {
  /** Content shown before the label (a flag or icon). */
  decorate?: (label: string) => Child;
  /** Display text for a label. */
  display?: (label: string) => string;
  /** Rows shown before "Show all". Default 8. */
  limit?: number;
  /** Format for values. Default: counts. */
  format?: (n: number) => string;
}

/** Horizontal bars behind each row, scaled to the largest value. */
export function barList(
  rows: BarRow[],
  headers: [string, string, string?],
  options: BarListOptions = {},
): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const limit = options.limit ?? 8;
  const fmtValue = options.format ?? count;
  const root = h('div', { class: 'bar-list' });
  const paint = (expanded: boolean) => {
    const shown = expanded ? rows : rows.slice(0, limit);
    mount(
      root,
      h(
        'div',
        { class: 'bar-head' },
        h('span', {}, headers[0]),
        h('span', { class: 'num' }, headers[1]),
        headers[2] ? h('span', { class: 'num' }, headers[2]) : null,
      ),
      ...shown.map((r) => {
        const text = options.display ? options.display(r.label) : r.label;
        const content = [
          options.decorate ? h('span', { class: 'bar-deco' }, options.decorate(r.label)) : null,
          h('span', { class: 'bar-text' }, text),
        ];
        const fill = h('span', {
          class: 'bar-fill',
          style: `width:${Math.max(1, (r.value / max) * 100)}%`,
        });
        return h(
          'div',
          {
            class: 'bar-row',
            title: `${text}: ${fmtValue(r.value)} (${percent(total ? r.value / total : 0, 0)})`,
          },
          r.href
            ? h('a', { class: 'bar-label', href: r.href }, fill, content)
            : h('span', { class: 'bar-label' }, fill, content),
          h('span', { class: 'num' }, fmtValue(r.value)),
          r.secondary !== undefined ? h('span', { class: 'num muted' }, count(r.secondary)) : null,
        );
      }),
      rows.length > limit
        ? h(
            'button',
            { type: 'button', class: 'link-button bar-more', onclick: () => paint(!expanded) },
            expanded ? 'Show fewer' : `Show all ${rows.length}`,
          )
        : null,
    );
  };
  paint(false);
  return root;
}

export interface FunnelStepView {
  label: string;
  /** People may skip this step. */
  optional?: boolean;
  /** The step's event, for linking to replays of people who dropped off. */
  event?: string;
  count: number;
  conversionFromStart: number;
  conversionFromPrevious: number;
  avgSecondsFromPrevious: number | null;
}

export interface FunnelBreakdownView {
  value: string;
  steps: FunnelStepView[];
}

export function kpiStat(
  label: string,
  value: string,
  hint?: Child,
  options: { color?: string; tag?: string } = {},
): HTMLElement {
  return h(
    'div',
    { class: 'stat' },
    h(
      'div',
      { class: 'stat-label' },
      options.tag
        ? h(
            'span',
            { class: 'series-tag', style: options.color ? `--tag:${options.color}` : null },
            options.tag,
          )
        : null,
      label,
    ),
    h('div', { class: 'stat-value' }, value),
    hint ? h('div', { class: 'stat-hint' }, hint) : null,
  );
}

/**
 * Amplitude-style funnel: headline KPIs, vertical bars scaled to the first
 * step with the drop-off hatched, then a step table and breakdowns.
 */
export function funnelChart(
  steps: FunnelStepView[],
  options: {
    windowSeconds?: number;
    breakdowns?: FunnelBreakdownView[];
    /** What was counted, plural: "people" (default), "sessions", "company groups"… */
    noun?: string;
  } = {},
): HTMLElement {
  const noun = options.noun ?? 'people';
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  const base = Math.max(1, first.count);
  const overall = first.count ? last.count / first.count : 0;
  const totalDrop = Math.max(0, first.count - last.count);
  const avgThrough =
    steps.length > 1
      ? steps.slice(1).reduce((sum, step) => sum + (step.avgSecondsFromPrevious ?? 0), 0)
      : null;
  const worst = steps
    .slice(1)
    .reduce<{ i: number; rate: number } | null>(
      (acc, step, k) =>
        !acc || step.conversionFromPrevious < acc.rate
          ? { i: k + 1, rate: step.conversionFromPrevious }
          : acc,
      null,
    );

  const columns = h(
    'div',
    { class: 'funnel-columns', style: `--steps:${steps.length}` },
    steps.map((step, i) => {
      const prev = i > 0 ? steps[i - 1]! : null;
      const dropped = prev ? Math.max(0, prev.count - step.count) : 0;
      return h(
        'div',
        { class: `funnel-col ${worst && worst.i === i ? 'worst' : ''}` },
        h(
          'div',
          { class: 'funnel-col-head' },
          h('span', { class: 'funnel-step-index' }, String(i + 1)),
          h('span', { class: 'step-name', title: step.label }, step.label),
          step.optional ? h('span', { class: 'badge' }, 'optional') : null,
        ),
        h(
          'div',
          {
            class: 'funnel-col-track',
            title: `${count(step.count)} ${noun}${prev ? `, ${count(dropped)} dropped` : ''}`,
          },
          prev
            ? h('div', { class: 'funnel-col-drop', style: `height:${(dropped / base) * 100}%` })
            : null,
          h(
            'div',
            {
              class: `funnel-col-fill ${step.count / base > 0.82 ? 'tall' : ''}`,
              style: `height:${Math.max(step.count ? 1 : 0, (step.count / base) * 100)}%`,
            },
            h('span', { class: 'funnel-col-pct' }, percent(step.conversionFromStart, 1)),
          ),
        ),
        h(
          'div',
          { class: 'funnel-col-foot' },
          h(
            'div',
            { class: 'funnel-col-count' },
            count(step.count),
            h('span', { class: 'muted' }, ` ${noun}`),
          ),
          prev
            ? h(
                'div',
                { class: 'funnel-col-rates' },
                h(
                  'span',
                  { class: 'funnel-bridge-convert' },
                  `${percent(step.conversionFromPrevious, 1)} converted`,
                ),
                h('span', { class: 'funnel-bridge-drop' }, `${count(dropped)} dropped`),
                step.avgSecondsFromPrevious !== null
                  ? h('span', { class: 'muted' }, `avg ${duration(step.avgSecondsFromPrevious)}`)
                  : null,
                dropped > 0 && prev.event && step.event
                  ? h(
                      'a',
                      {
                        class: 'funnel-replays',
                        href: href('replays', { did: prev.event, not: step.event }),
                        title: `Recorded sessions with ${prev.event} but no ${step.event}`,
                      },
                      icon('replay', 12),
                      'Watch drop-offs',
                    )
                  : null,
              )
            : h(
                'div',
                { class: 'funnel-col-rates' },
                h('span', { class: 'muted' }, 'Entered the funnel'),
              ),
        ),
      );
    }),
  );

  const breakdowns = options.breakdowns?.length
    ? h(
        'div',
        { class: 'funnel-breakdowns' },
        h('h3', { class: 'funnel-breakdowns-title' }, 'Breakdown'),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'funnel-breakdown-table' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', {}, 'Segment'),
                ...steps.map((st) => h('th', { class: 'num' }, st.label)),
                h('th', { class: 'num' }, 'Conversion'),
              ),
            ),
            h(
              'tbody',
              {},
              options.breakdowns.map((b, bi) => {
                const bFirst = b.steps[0]?.count ?? 0;
                const bLast = b.steps[b.steps.length - 1]?.count ?? 0;
                const conv = bFirst ? bLast / bFirst : 0;
                return h(
                  'tr',
                  {},
                  h(
                    'td',
                    {},
                    h('span', {
                      class: 'swatch',
                      style: `background:${SERIES[bi % SERIES.length]}`,
                    }),
                    h('code', {}, b.value),
                  ),
                  ...b.steps.map((st) =>
                    h(
                      'td',
                      { class: 'num' },
                      h('div', { class: 'funnel-bd-count' }, count(st.count)),
                      h('div', { class: 'muted small' }, percent(st.conversionFromStart, 0)),
                    ),
                  ),
                  h(
                    'td',
                    { class: 'num' },
                    h(
                      'div',
                      { class: 'funnel-bd-conv' },
                      h(
                        'span',
                        { class: 'funnel-bd-conv-track' },
                        h('span', { class: 'funnel-bd-conv-bar', style: `width:${conv * 100}%` }),
                      ),
                      h('span', {}, percent(conv, 1)),
                    ),
                  ),
                );
              }),
            ),
          ),
        ),
      )
    : null;

  return h(
    'div',
    { class: 'funnel funnel-view' },
    h(
      'div',
      { class: 'stats' },
      kpiStat(
        'Conversion',
        percent(overall, 1),
        `${count(last.count)} of ${count(first.count)} ${noun}`,
      ),
      kpiStat('Completed', count(last.count), last.label),
      kpiStat(
        'Drop-off',
        count(totalDrop),
        first.count ? `${percent(totalDrop / first.count, 1)} of starters` : undefined,
      ),
      avgThrough !== null && avgThrough > 0
        ? kpiStat('Avg. time to convert', duration(avgThrough), 'first step → last step')
        : null,
      options.windowSeconds ? kpiStat('Conversion window', duration(options.windowSeconds)) : null,
    ),
    columns,
    worst && steps.length > 2
      ? h(
          'p',
          { class: 'funnel-callout' },
          'Biggest drop-off: into ',
          h('strong', {}, steps[worst.i]!.label),
          ` (${percent(1 - worst.rate, 1)} of the previous step lost).`,
        )
      : null,
    breakdowns,
  );
}

export interface CohortView {
  start: number;
  size: number;
  counts: number[];
  rates: number[];
}

const PERIOD_MS: Record<string, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
};

/** Whether period `k` of a cohort starting at `start` has fully happened yet. */
export function periodReached(start: number, k: number, period: string, now = Date.now()): boolean {
  const at =
    period === 'month' ? addMonths(start, k) : start + k * (PERIOD_MS[period] ?? PERIOD_MS.week!);
  return at <= now;
}

export function retentionGrid(
  cohorts: CohortView[],
  average: number[],
  period: string,
  now = Date.now(),
  /** Click a cohort's cell to see who it counts. */
  onCell?: (cohortStart: number, k: number) => void,
): HTMLElement {
  const periods = average.length;
  const reachedAny = (k: number) => cohorts.some((c) => periodReached(c.start, k, period, now));
  const cell = (rate: number, n: number | null, reached: boolean, open?: () => void) => {
    if (!reached) return h('td', { class: 'num heat na', title: 'Not reached yet' }, '');
    const heat = Math.round(Math.sqrt(Math.max(0, rate)) * 100);
    const text = percent(rate, rate < 0.1 && rate > 0 ? 1 : 0);
    return h(
      'td',
      {
        class: `num heat ${heat > 62 ? 'dark' : ''}`,
        style: `--heat:${heat}`,
        title: n === null ? undefined : `${count(n)} people${open ? ': click to see them' : ''}`,
      },
      open && n ? h('button', { type: 'button', class: 'cell-button', onclick: open }, text) : text,
    );
  };
  const rowLabel = (start: number) =>
    period === 'hour'
      ? `${bucketLabel(start, 'day')} ${bucketLabel(start, 'hour')}`
      : bucketLabel(start, period === 'month' ? 'month' : 'day');
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'retention' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', {}, 'Cohort'),
          h('th', { class: 'num' }, 'People'),
          Array.from({ length: periods }, (_, k) =>
            h('th', { class: 'num' }, `${period[0]!.toUpperCase()}${k}`),
          ),
        ),
      ),
      h(
        'tbody',
        {},
        h(
          'tr',
          { class: 'average' },
          h('td', {}, 'Average'),
          h('td', { class: 'num' }, count(cohorts.reduce((n, c) => n + c.size, 0))),
          average.map((r, k) => cell(r, null, reachedAny(k))),
        ),
        cohorts.map((c) =>
          h(
            'tr',
            {},
            h('td', {}, rowLabel(c.start)),
            h('td', { class: 'num' }, count(c.size)),
            c.rates.map((r, k) =>
              cell(
                r,
                c.counts[k] ?? 0,
                periodReached(c.start, k, period, now),
                onCell ? () => onCell(c.start, k) : undefined,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Average retention by period as a curve, stopping at the last period any cohort has reached. */
export function retentionCurve(
  cohorts: CohortView[],
  average: number[],
  period: string,
  now = Date.now(),
): HTMLElement | null {
  let reached = average.length;
  while (reached > 0 && !cohorts.some((c) => periodReached(c.start, reached - 1, period, now)))
    reached--;
  if (reached < 2) return null;
  const values = average.slice(0, reached);
  return lineChart(
    values.map((_, i) => i),
    [{ label: 'Retained', values }],
    period,
    {
      height: 200,
      labels: values.map((_, k) => `${period[0]!.toUpperCase()}${k}`),
      format: (v) => percent(v, 0),
      yMax: 1,
      type: 'area',
    },
  );
}
