/**
 * Starter analyses seeded into every new project (and into empty existing ones
 * the first time Insights is opened). All use $pageview so they work before
 * any custom events are tracked.
 */

export interface DefaultInsight {
  key: string;
  name: string;
  description: string;
  kind: 'trends' | 'funnel' | 'retention';
  spec: Record<string, unknown>;
}

export const DEFAULT_INSIGHTS: readonly DefaultInsight[] = [
  {
    key: 'dau',
    name: 'Daily active users',
    description: 'Unique people who viewed a page each day.',
    kind: 'trends',
    spec: { series: [{ event: '$pageview', math: 'unique_persons', label: 'DAU' }], interval: 'day' },
  },
  {
    key: 'wau',
    name: 'Weekly active users',
    description: 'Unique people who viewed a page each week.',
    kind: 'trends',
    spec: { series: [{ event: '$pageview', math: 'unique_persons', label: 'WAU' }], interval: 'week' },
  },
  {
    key: 'mau',
    name: 'Monthly active users',
    description: 'Unique people who viewed a page each month.',
    kind: 'trends',
    spec: { series: [{ event: '$pageview', math: 'unique_persons', label: 'MAU' }], interval: 'month' },
  },
  {
    key: 'daily-pageviews',
    name: 'Daily pageviews',
    description: 'Total pageviews per day.',
    kind: 'trends',
    spec: { series: [{ event: '$pageview', math: 'total', label: 'Pageviews' }], interval: 'day' },
  },
  {
    key: 'daily-retention',
    name: 'Daily retention',
    description: 'Of people who first viewed a page on a given day, how many came back on later days.',
    kind: 'retention',
    spec: {
      cohortEvent: { event: '$pageview' },
      returnEvent: { event: '$pageview' },
      period: 'day',
      periods: 14,
    },
  },
  {
    key: 'weekly-retention',
    name: 'Weekly retention',
    description: 'Of people who first viewed a page in a given week, how many came back in later weeks.',
    kind: 'retention',
    spec: {
      cohortEvent: { event: '$pageview' },
      returnEvent: { event: '$pageview' },
      period: 'week',
      periods: 8,
    },
  },
];
