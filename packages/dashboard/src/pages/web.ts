/**
 * Web analytics: the Plausible-style default view.
 */

import type { BreakdownRow, WebBreakdown, WebResult } from '@glass/core/insights/web';
import { api } from '../api.ts';
import { barList, lineChart } from '../components/charts.ts';
import { empty, later, pageHeader, panel, tabs } from '../components/ui.ts';
import { h, mount } from '../dom.ts';
import { apiFilters, filterChips, filterHref } from '../filters.ts';
import { change, count, decimal, duration, percent } from '../format.ts';
import { scope } from '../state.ts';

type Result = WebResult & { project: string };

/** Which filter property each breakdown row applies when clicked. */
const FILTER_FOR: Partial<Record<WebBreakdown, string>> = {
  pages: 'path',
  entry_pages: 'path',
  exit_pages: 'path',
  referrers: 'referrer_host',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  countries: 'country',
  devices: 'device',
  browsers: 'browser',
  os: 'os',
};

function kpis(r: Result): HTMLElement {
  const items: { label: string; value: string; now: number; before?: number; lowerIsBetter?: boolean }[] = [
    { label: 'Visitors', value: count(r.totals.visitors), now: r.totals.visitors, before: r.previous?.visitors },
    { label: 'Pageviews', value: count(r.totals.pageviews), now: r.totals.pageviews, before: r.previous?.pageviews },
    { label: 'Sessions', value: count(r.totals.sessions), now: r.totals.sessions, before: r.previous?.sessions },
    { label: 'Bounce rate', value: percent(r.totals.bounceRate, 0), now: r.totals.bounceRate, before: r.previous?.bounceRate, lowerIsBetter: true },
    { label: 'Session length', value: duration(r.totals.avgSessionSeconds), now: r.totals.avgSessionSeconds, before: r.previous?.avgSessionSeconds },
    { label: 'Views per session', value: decimal(r.totals.viewsPerSession, 1), now: r.totals.viewsPerSession, before: r.previous?.viewsPerSession },
  ];
  return h(
    'dl',
    { class: 'kpis' },
    items.map((item) => {
      const c = change(item.now, item.before);
      const good = c && c.direction !== 'flat' && (c.direction === 'up') !== Boolean(item.lowerIsBetter);
      return h(
        'div',
        { class: 'kpi' },
        h('dt', {}, item.label),
        h('dd', {}, item.value, c ? h('span', { class: `delta ${c.direction === 'flat' ? '' : good ? 'good' : 'bad'}`, title: 'vs previous period' }, c.text) : null),
      );
    }),
  );
}

function breakdownPanel(r: Result, title: string, options: { key: WebBreakdown; label: string }[], headers: [string, string, string?]): HTMLElement {
  const body = h('div', {});
  let selected = options[0]!.key;
  const render = () => {
    const rows: BreakdownRow[] = r.breakdowns[selected] ?? [];
    const filter = FILTER_FOR[selected];
    mount(
      body,
      options.length > 1 ? tabs(options.map((o) => ({ value: o.key, label: o.label })), selected, (v) => {
        selected = v;
        render();
      }) : null,
      rows.length
        ? barList(
            rows.map((row) => ({
              label: row.value,
              value: selected === 'errors' ? row.count : row.visitors,
              secondary: selected === 'errors' ? row.visitors : row.count,
              href: filter && row.value !== '(none)' && row.value !== 'Direct / None' ? filterHref(filter, row.value) : undefined,
            })),
            headers,
          )
        : empty('Nothing here for this period.'),
    );
  };
  render();
  return panel(title, body, { sql: [r.sql[r.sql.length - 2]!] });
}

function vitalsPanel(r: Result): HTMLElement {
  const thresholds: Record<string, [number, number, (n: number) => string]> = {
    LCP: [2500, 4000, (n) => `${(n / 1000).toFixed(2)}s`],
    INP: [200, 500, (n) => `${Math.round(n)}ms`],
    CLS: [0.1, 0.25, (n) => n.toFixed(2)],
    FCP: [1800, 3000, (n) => `${(n / 1000).toFixed(2)}s`],
    TTFB: [800, 1800, (n) => `${Math.round(n)}ms`],
  };
  const metrics = Object.entries(r.vitals);
  return panel(
    'Web vitals (p75)',
    metrics.length
      ? h(
          'dl',
          { class: 'vitals' },
          metrics.map(([name, v]) => {
            const [good, poor, show] = thresholds[name] ?? [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, (n: number) => String(n)];
            const rating = v.p75 <= good ? 'good' : v.p75 <= poor ? 'ok' : 'poor';
            return h('div', { class: `vital ${rating}` }, h('dt', {}, name), h('dd', {}, show(v.p75)), h('span', { class: 'muted small' }, `${count(v.samples)} ${v.samples === 1 ? 'sample' : 'samples'}`));
          }),
        )
      : empty('No web vitals yet. They are sent when a visitor leaves a page.'),
    { sql: [r.sql[r.sql.length - 1]!] },
  );
}

export function webPage(): Node[] {
  const sc = scope();
  return [
    pageHeader('Web', 'Visitors, pages and sources. Click any row to filter.'),
    filterChips() ?? h('span', {}),
    later(async () => {
      const r = await api.post<Result>('/api/query', { kind: 'web', ...sc, filters: apiFilters() });
      if (r.totals.pageviews === 0 && !r.previous?.pageviews) {
        return empty('No pageviews yet. Add the script tag to your site, then visit a page.', h('a', { class: 'button', href: '#/settings' }, 'Show the install snippet'));
      }
      return [
        kpis(r),
        panel('Visitors and pageviews', lineChart(r.timeseries.buckets, [{ label: 'Visitors', values: r.timeseries.visitors }, { label: 'Pageviews', values: r.timeseries.pageviews }], r.interval), {
          sql: [r.sql[0]!, r.sql[r.previous ? 2 : 1]!],
          class: 'wide',
        }),
        h(
          'div',
          { class: 'grid-2' },
          breakdownPanel(r, 'Pages', [
            { key: 'pages', label: 'Top' },
            { key: 'entry_pages', label: 'Entry' },
            { key: 'exit_pages', label: 'Exit' },
          ], ['Page', 'Visitors', 'Views']),
          breakdownPanel(r, 'Sources', [
            { key: 'referrers', label: 'Referrers' },
            { key: 'utm_source', label: 'Source' },
            { key: 'utm_medium', label: 'Medium' },
            { key: 'utm_campaign', label: 'Campaign' },
          ], ['Source', 'Visitors', 'Visits']),
          breakdownPanel(r, 'Locations', [{ key: 'countries', label: 'Countries' }], ['Country', 'Visitors', 'Views']),
          breakdownPanel(r, 'Devices', [
            { key: 'devices', label: 'Device' },
            { key: 'browsers', label: 'Browser' },
            { key: 'os', label: 'OS' },
          ], ['Device', 'Visitors', 'Views']),
          breakdownPanel(r, 'Errors', [{ key: 'errors', label: 'Errors' }], ['Message', 'Times', 'Visitors']),
          vitalsPanel(r),
        ),
      ];
    }),
  ];
}
