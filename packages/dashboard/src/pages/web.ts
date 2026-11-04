/**
 * Reports: Web (default), Marketing, and Health.
 *
 * One `/api/query` kind=web fetch powers all three tabs; the tabs only change
 * which panels are shown. With "compare" on, a second fetch for the previous
 * period draws the dashed line on the main chart.
 */

import type { BreakdownRow, WebBreakdown, WebResult } from '@glassanalytics/core/insights/web';
import { api } from '../api.ts';
import { barList, lineChart, sparkline } from '../components/charts.ts';
import { previousRange } from '../components/date-range.ts';
import { type IconName, icon } from '../components/icons.ts';
import { empty, later, pageHeader, panel, tabs } from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { apiFilters, filterChips, filterHref } from '../filters.ts';
import {
  capitalize,
  change,
  count,
  countryFlag,
  countryName,
  decimal,
  duration,
  percent,
} from '../format.ts';
import { currentRoute, go, prefs, type Route, scope } from '../state.ts';

type Result = WebResult & { project: string };
type ReportTab = 'web' | 'marketing' | 'health';
type Metric = 'visitors' | 'pageviews';

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

const DEVICE_ICON: Record<string, IconName> = {
  desktop: 'monitor',
  mobile: 'smartphone',
  tablet: 'tablet',
};

/** Labels and decorations per breakdown. */
const DECOR: Partial<
  Record<WebBreakdown, { display?: (v: string) => string; decorate?: (v: string) => Child }>
> = {
  countries: {
    display: countryName,
    decorate: (v) => h('span', { class: 'flag' }, countryFlag(v) || icon('globe', 14)),
  },
  devices: { display: capitalize, decorate: (v) => icon(DEVICE_ICON[v] ?? 'monitor', 14) },
  referrers: {
    decorate: (v) =>
      v === 'Direct / None' || v === '(none)'
        ? icon('arrowRight', 14)
        : h('span', { class: 'favicon' }, (v.replace(/^www\./, '')[0] ?? '?').toUpperCase()),
  },
  errors: { decorate: () => icon('alert', 14) },
};

function metric(): Metric {
  return currentRoute().params.get('metric') === 'pageviews' ? 'pageviews' : 'visitors';
}

function kpis(r: Result, onSelect: (m: Metric) => void, selected: Metric): HTMLElement {
  const items: {
    key?: Metric;
    label: string;
    value: string;
    now: number;
    before?: number;
    lowerIsBetter?: boolean;
    spark?: number[];
  }[] = [
    {
      key: 'visitors',
      label: 'Visitors',
      value: count(r.totals.visitors),
      now: r.totals.visitors,
      before: r.previous?.visitors,
      spark: r.timeseries.visitors,
    },
    {
      key: 'pageviews',
      label: 'Pageviews',
      value: count(r.totals.pageviews),
      now: r.totals.pageviews,
      before: r.previous?.pageviews,
      spark: r.timeseries.pageviews,
    },
    {
      label: 'Sessions',
      value: count(r.totals.sessions),
      now: r.totals.sessions,
      before: r.previous?.sessions,
    },
    {
      label: 'Bounce rate',
      value: percent(r.totals.bounceRate, 0),
      now: r.totals.bounceRate,
      before: r.previous?.bounceRate,
      lowerIsBetter: true,
    },
    {
      label: 'Session length',
      value: duration(r.totals.avgSessionSeconds),
      now: r.totals.avgSessionSeconds,
      before: r.previous?.avgSessionSeconds,
    },
    {
      label: 'Views per session',
      value: decimal(r.totals.viewsPerSession, 1),
      now: r.totals.viewsPerSession,
      before: r.previous?.viewsPerSession,
    },
  ];
  return h(
    'dl',
    { class: 'kpis' },
    items.map((item) => {
      const c = change(item.now, item.before);
      const good =
        c && c.direction !== 'flat' && (c.direction === 'up') !== Boolean(item.lowerIsBetter);
      const delta = c
        ? h(
            'span',
            {
              class: `delta ${c.direction === 'flat' ? '' : good ? 'good' : 'bad'}`,
              title: 'vs previous period',
            },
            c.direction === 'up'
              ? icon('arrowUp', 12)
              : c.direction === 'down'
                ? icon('arrowDown', 12)
                : null,
            c.text.replace(/^[+−]/, ''),
          )
        : null;
      const selectable = Boolean(item.key);
      return h(
        'div',
        {
          class: `kpi ${selectable ? 'selectable' : ''} ${item.key === selected ? 'selected' : ''}`,
          role: selectable ? 'button' : null,
          tabindex: selectable ? 0 : null,
          'aria-pressed': selectable ? String(item.key === selected) : null,
          title: selectable ? `Chart ${item.label.toLowerCase()}` : null,
          onclick: selectable ? () => onSelect(item.key!) : null,
          onkeydown: selectable
            ? (e: Event) => {
                if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
                  e.preventDefault();
                  onSelect(item.key!);
                }
              }
            : null,
        },
        h('dt', {}, item.label),
        h('dd', {}, item.value, delta),
        item.spark && item.spark.length > 1
          ? sparkline(item.spark, { height: 28 })
          : h('div', { class: 'kpi-spacer' }),
      );
    }),
  );
}

function breakdownPanel(
  r: Result,
  title: string,
  panelIcon: IconName,
  options: { key: WebBreakdown; label: string }[],
  headers: [string, string, string?],
): HTMLElement {
  const body = h('div', {});
  let selected = options[0]!.key;
  const switcher = () =>
    options.length > 1
      ? tabs(
          options.map((o) => ({ value: o.key, label: o.label })),
          selected,
          (v) => {
            selected = v;
            render();
            mount(actions, switcher());
          },
          'tabs-small',
        )
      : null;
  const actions = h('div', {}, switcher());
  const render = () => {
    const rows: BreakdownRow[] = r.breakdowns[selected] ?? [];
    const filter = FILTER_FOR[selected];
    const decor = DECOR[selected] ?? {};
    mount(
      body,
      rows.length
        ? barList(
            rows.map((row) => ({
              label: row.value,
              value: selected === 'errors' ? row.count : row.visitors,
              secondary: selected === 'errors' ? row.visitors : row.count,
              href:
                filter && row.value !== '(none)' && row.value !== 'Direct / None'
                  ? filterHref(filter, row.value)
                  : undefined,
            })),
            headers,
            decor,
          )
        : empty('Nothing here for this period.'),
    );
  };
  render();
  return panel(title, body, { sql: [r.sql[r.sql.length - 2]!], actions, icon: panelIcon });
}

const VITALS: Record<
  string,
  { good: number; poor: number; show: (n: number) => string; name: string }
> = {
  LCP: {
    good: 2500,
    poor: 4000,
    show: (n) => `${(n / 1000).toFixed(2)}s`,
    name: 'Largest Contentful Paint',
  },
  INP: {
    good: 200,
    poor: 500,
    show: (n) => `${Math.round(n)}ms`,
    name: 'Interaction to Next Paint',
  },
  CLS: { good: 0.1, poor: 0.25, show: (n) => n.toFixed(2), name: 'Cumulative Layout Shift' },
  FCP: {
    good: 1800,
    poor: 3000,
    show: (n) => `${(n / 1000).toFixed(2)}s`,
    name: 'First Contentful Paint',
  },
  TTFB: { good: 800, poor: 1800, show: (n) => `${Math.round(n)}ms`, name: 'Time to First Byte' },
};

function vitalsPanel(r: Result): HTMLElement {
  const metrics = Object.entries(r.vitals);
  return panel(
    'Web vitals',
    metrics.length
      ? h(
          'dl',
          { class: 'vitals' },
          metrics.map(([name, v]) => {
            const t = VITALS[name] ?? {
              good: Number.POSITIVE_INFINITY,
              poor: Number.POSITIVE_INFINITY,
              show: (n: number) => String(n),
              name,
            };
            const rating = v.p75 <= t.good ? 'good' : v.p75 <= t.poor ? 'ok' : 'poor';
            // Position on a scale where "poor" sits at 2/3 of the bar.
            const pos = Math.min(100, (v.p75 / (t.poor * 1.5)) * 100);
            return h(
              'div',
              {
                class: `vital ${rating}`,
                title: `${t.name}: good ≤ ${t.show(t.good)}, poor > ${t.show(t.poor)}`,
              },
              h(
                'dt',
                {},
                name,
                h(
                  'span',
                  { class: `vital-badge ${rating}` },
                  rating === 'good' ? 'Good' : rating === 'ok' ? 'Needs work' : 'Poor',
                ),
              ),
              h('dd', {}, t.show(v.p75)),
              h(
                'div',
                { class: 'vital-scale' },
                h('span', { class: 'vital-marker', style: `left:${pos}%` }),
              ),
              h(
                'span',
                { class: 'muted small' },
                `${t.name} · ${count(v.samples)} ${v.samples === 1 ? 'sample' : 'samples'}`,
              ),
            );
          }),
        )
      : empty('No web vitals yet. They are sent when a visitor leaves a page.', undefined, {
          icon: 'gauge',
        }),
    {
      sql: [r.sql[r.sql.length - 1]!],
      subtitle: '75th percentile, as Google rates it',
      icon: 'gauge',
    },
  );
}

function mainChart(r: Result, selected: Metric): HTMLElement {
  const label = selected === 'visitors' ? 'Visitors' : 'Pageviews';
  const holder = h('div', {});
  const draw = (previous?: number[]) =>
    mount(
      holder,
      lineChart(
        r.timeseries.buckets,
        [{ label, values: r.timeseries[selected], previous }],
        r.interval,
        { height: 280, type: 'area' },
      ),
    );
  draw();
  const sc = scope();
  const prev = prefs.compare ? previousRange(sc.from, sc.to) : null;
  if (prev) {
    void api
      .post<Result>('/api/query', {
        kind: 'web',
        project: sc.project,
        from: prev.from,
        to: prev.to,
        interval: r.interval,
        compare: false,
        filters: apiFilters(),
      })
      .then((p) => draw(p.timeseries[selected]))
      .catch(() => undefined);
  }
  const switcher = tabs(
    [
      { value: 'visitors' as Metric, label: 'Visitors' },
      { value: 'pageviews' as Metric, label: 'Pageviews' },
    ],
    selected,
    (m) => setMetric(m),
    'tabs-small',
  );
  return panel(label, holder, {
    sql: [r.sql[0]!, r.sql[r.previous ? 2 : 1]!],
    class: 'wide chart-panel',
    actions: switcher,
    subtitle: `${count(r.totals[selected])} in this period${r.previous ? ` · ${count(r.previous[selected])} the period before` : ''}`,
  });
}

function setMetric(m: Metric): void {
  const route = currentRoute();
  go([route.page, ...route.rest].join('/'), {
    ...Object.fromEntries(route.params),
    metric: m === 'visitors' ? null : m,
  });
}

function webReport(r: Result): Node[] {
  const selected = metric();
  return [
    kpis(r, setMetric, selected),
    mainChart(r, selected),
    h(
      'div',
      { class: 'grid-3' },
      breakdownPanel(
        r,
        'Pages',
        'events',
        [
          { key: 'pages', label: 'Top' },
          { key: 'entry_pages', label: 'Entry' },
          { key: 'exit_pages', label: 'Exit' },
        ],
        ['Page', 'Visitors', 'Views'],
      ),
      breakdownPanel(
        r,
        'Locations',
        'globe',
        [{ key: 'countries', label: 'Countries' }],
        ['Country', 'Visitors', 'Views'],
      ),
      breakdownPanel(
        r,
        'Devices',
        'monitor',
        [
          { key: 'devices', label: 'Device' },
          { key: 'browsers', label: 'Browser' },
          { key: 'os', label: 'OS' },
        ],
        ['Device', 'Visitors', 'Views'],
      ),
    ),
  ];
}

function marketingReport(r: Result): Node[] {
  return [
    kpis(r, setMetric, metric()),
    h(
      'div',
      { class: 'grid-2' },
      breakdownPanel(
        r,
        'Referrers',
        'external',
        [{ key: 'referrers', label: 'Referrers' }],
        ['Referrer', 'Visitors', 'Visits'],
      ),
      breakdownPanel(
        r,
        'Campaigns',
        'megaphone',
        [
          { key: 'utm_source', label: 'Source' },
          { key: 'utm_medium', label: 'Medium' },
          { key: 'utm_campaign', label: 'Campaign' },
        ],
        ['Value', 'Visitors', 'Visits'],
      ),
    ),
  ];
}

function healthReport(r: Result): Node[] {
  return [
    h(
      'div',
      { class: 'grid-2' },
      breakdownPanel(
        r,
        'JavaScript errors',
        'alert',
        [{ key: 'errors', label: 'Errors' }],
        ['Message', 'Times', 'Visitors'],
      ),
      vitalsPanel(r),
    ),
  ];
}

const TAB_COPY: Record<ReportTab, string> = {
  web: 'Traffic, pages, locations and devices. Click any row to filter.',
  marketing: 'How people found you: referrers and UTM campaigns.',
  health: 'Whether the site is broken or slow: JavaScript errors and Core Web Vitals.',
};

function parseTab(rest: string[]): ReportTab {
  const raw = rest[0] ?? 'web';
  return raw === 'marketing' || raw === 'health' || raw === 'web' ? raw : 'web';
}

export function webPage(route: Route): Node[] {
  const tab = parseTab(route.rest);
  const sc = scope();
  return [
    pageHeader(
      'Reports',
      TAB_COPY[tab],
      tabs(
        [
          { value: 'web', label: 'Web', icon: 'globe' },
          { value: 'marketing', label: 'Marketing', icon: 'megaphone' },
          { value: 'health', label: 'Health', icon: 'gauge' },
        ],
        tab,
        (next) => go(next === 'web' ? 'reports' : `reports/${next}`),
      ),
    ),
    filterChips() ?? h('span', {}),
    later(
      async () => {
        const r = await api.post<Result>('/api/query', {
          kind: 'web',
          ...sc,
          filters: apiFilters(),
        });
        if (r.totals.pageviews === 0 && !r.previous?.pageviews) {
          return empty(
            'Add the script tag to your site, then visit a page. Numbers appear within seconds.',
            h(
              'a',
              { class: 'button primary', href: '#/settings' },
              icon('code', 14),
              'Show the install snippet',
            ),
            {
              icon: 'reports',
              title: 'No pageviews yet',
            },
          );
        }
        if (tab === 'marketing') return marketingReport(r);
        if (tab === 'health') return healthReport(r);
        return webReport(r);
      },
      'Loading reports',
      'report',
    ),
  ];
}
