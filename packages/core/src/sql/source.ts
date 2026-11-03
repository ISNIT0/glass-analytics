/**
 * Building blocks shared by all insight compilers.
 */

import type { Filter } from '../filters.ts';
import { DAY_MS, HOUR_MS, type Interval, WEEK_MS } from '../time.ts';
import type { Dialect } from './dialect.ts';
import { filtersSql } from './filters.ts';

export interface SourceOptions {
  project: string;
  /** Inclusive, epoch ms. */
  from: number;
  /** Exclusive, epoch ms. */
  to: number;
  /** Restrict to these event names (pushes the filter down for cheaper scans). */
  events?: readonly string[];
  filters?: readonly Filter[];
}

/**
 * The `ev` CTE every query starts from: events in range for one project, plus a
 * resolved `pid` (person id).
 *
 * Identity resolution happens here, at query time, so it is correct in both
 * stores without rewriting old rows:
 *
 * - events that carry a `user_id` belong to that user;
 * - anonymous events belong to whichever user their `distinct_id` was later
 *   linked to by `identify()` (the `identities` table), or else to the device.
 *
 * This is what makes a funnel like "visited pricing → signed up → purchased"
 * connect the anonymous pricing visit to the person who later signed up.
 */
export function eventsCte(d: Dialect, o: SourceOptions): string {
  const where = [
    `e.project = ${d.str(o.project)}`,
    `e.ts_ms >= ${d.num(Math.floor(o.from))}`,
    `e.ts_ms < ${d.num(Math.ceil(o.to))}`,
  ];
  if (o.events && o.events.length > 0 && !o.events.includes('*')) {
    const unique = [...new Set(o.events)];
    where.push(`e.event IN (${unique.map((n) => d.str(n)).join(', ')})`);
  }
  if (o.filters && o.filters.length > 0) where.push(filtersSql(o.filters, d, 'e'));
  return `ev AS (
  SELECT e.*,
    CASE WHEN e.user_id IS NOT NULL AND e.user_id <> '' THEN e.user_id ELSE COALESCE(i.person_id, e.person_id) END AS pid
  FROM ${d.table('events')} e
  LEFT JOIN (
    SELECT distinct_id, MIN(person_id) AS person_id
    FROM ${d.table('identities')}
    WHERE project = ${d.str(o.project)}
    GROUP BY distinct_id
  ) i ON i.distinct_id = e.distinct_id
  WHERE ${where.join('\n    AND ')}
)`;
}

/**
 * Start of the bucket containing `tsMs`, as epoch ms, computed in SQL.
 * Hours, days and weeks are integer arithmetic (identical in every engine);
 * months need calendar logic, delegated to the dialect.
 */
export function bucketExpr(d: Dialect, tsMs: string, interval: Interval, utcOffsetMinutes = 0): string {
  const off = utcOffsetMinutes * 60_000;
  const local = off === 0 ? tsMs : `(${tsMs} + ${off})`;
  const back = off === 0 ? '' : ` - ${off}`;
  switch (interval) {
    case 'hour':
      return `((${local} / ${HOUR_MS}) * ${HOUR_MS}${back})`;
    case 'day':
      return `((${local} / ${DAY_MS}) * ${DAY_MS}${back})`;
    case 'week': {
      // Weeks start on Monday. Day 0 (1970-01-01) was a Thursday, so (day + 3) % 7 is 0 on Mondays.
      const day = `(${local} / ${DAY_MS})`;
      return `((${day} - ((${day} + 3) % 7)) * ${DAY_MS}${back})`;
    }
    case 'month':
      return `(${d.monthStartMs(local)}${back})`;
  }
}

/** Length of a fixed interval in ms (weeks and below). */
export function fixedIntervalMs(interval: Exclude<Interval, 'month'>): number {
  return interval === 'hour' ? HOUR_MS : interval === 'day' ? DAY_MS : WEEK_MS;
}

/** Normalise numeric cells: engines may return integers as strings or bigints. */
export function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return 0;
}

export function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}
