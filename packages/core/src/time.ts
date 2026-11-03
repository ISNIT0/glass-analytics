/**
 * Date ranges and intervals.
 *
 * Agents (and humans) mostly think in relative terms — "last 30 days" — so every
 * query accepts relative expressions as well as ISO dates. All bucketing is UTC,
 * optionally shifted by a fixed `utcOffsetMinutes`.
 */

export type Interval = 'hour' | 'day' | 'week' | 'month';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/** Milliseconds per interval. Months are variable and handled separately. */
export const INTERVAL_MS: Record<Exclude<Interval, 'month'>, number> = {
  hour: HOUR_MS,
  day: DAY_MS,
  week: WEEK_MS,
};

const RELATIVE = /^-?(\d+)\s*(m|min|h|d|w|mo|y)$/i;
const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, h: HOUR_MS, d: DAY_MS, w: WEEK_MS };

/**
 * Parse a point in time.
 *
 * Accepts: `now`, `today` (UTC midnight), `yesterday`, relative offsets
 * (`-30d`, `7d`, `-12h`, `-2w`, `-3mo`, `-1y`), ISO dates or epoch milliseconds.
 * Relative offsets always point into the past.
 */
export function parseTime(input: string | number, now: number = Date.now()): number {
  if (typeof input === 'number') return input;
  const value = input.trim().toLowerCase();
  if (value === 'now') return now;
  if (value === 'today') return startOfDay(now);
  if (value === 'yesterday') return startOfDay(now) - DAY_MS;
  const rel = RELATIVE.exec(value);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    if (unit === 'mo') return addMonths(now, -n);
    if (unit === 'y') return addMonths(now, -12 * n);
    return now - n * UNIT_MS[unit]!;
  }
  if (/^\d{10,}$/.test(value)) return Number(value);
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    throw new RangeError(
      `Cannot parse time "${input}". Use an ISO date (2026-10-01), "now", "today" or a relative offset like "-30d".`,
    );
  }
  return parsed;
}

export interface TimeRange {
  /** Inclusive start, ms. */
  from: number;
  /** Exclusive end, ms. */
  to: number;
}

/** Resolve `from`/`to` expressions into an absolute range. Defaults to the last 30 days. */
export function resolveRange(
  from: string | number | undefined,
  to: string | number | undefined,
  now: number = Date.now(),
): TimeRange {
  const range = {
    from: parseTime(from ?? '-30d', now),
    to: parseTime(to ?? 'now', now),
  };
  if (range.to <= range.from) {
    throw new RangeError(`Empty time range: "from" (${iso(range.from)}) must be before "to" (${iso(range.to)}).`);
  }
  return range;
}

export function startOfDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Add calendar months, clamping the day (31 Oct - 1 month = 30 Sep, not 1 Oct). */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  target.setUTCHours(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  return target.getTime();
}

/** Start of the bucket containing `ms`. Weeks start on Monday. */
export function bucketStart(ms: number, interval: Interval, utcOffsetMinutes = 0): number {
  const off = utcOffsetMinutes * 60_000;
  const local = ms + off;
  if (interval === 'month') {
    const d = new Date(local);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - off;
  }
  if (interval === 'week') {
    const day = Math.floor(local / DAY_MS);
    // 1970-01-01 was a Thursday; (day + 3) % 7 === 0 on Mondays.
    return (day - ((day + 3) % 7)) * DAY_MS - off;
  }
  return Math.floor(local / INTERVAL_MS[interval]) * INTERVAL_MS[interval] - off;
}

/** Every bucket start from `from` (bucketed) up to `to` (exclusive). Used to fill gaps in time series. */
export function bucketsBetween(range: TimeRange, interval: Interval, utcOffsetMinutes = 0, max = 2000): number[] {
  const out: number[] = [];
  let cursor = bucketStart(range.from, interval, utcOffsetMinutes);
  while (cursor < range.to && out.length < max) {
    out.push(cursor);
    cursor =
      interval === 'month'
        ? bucketStart(addMonths(cursor + 15 * DAY_MS, 1), 'month', utcOffsetMinutes)
        : cursor + INTERVAL_MS[interval];
  }
  return out;
}

/** Parse a duration such as `7d`, `24h`, `30m` or a number of seconds into milliseconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return input * 1000;
  const m = /^(\d+)\s*(s|m|min|h|d|w)$/i.exec(input.trim());
  if (!m) throw new RangeError(`Cannot parse duration "${input}". Use e.g. "30m", "24h", "7d" or seconds.`);
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const ms = unit === 's' ? 1000 : UNIT_MS[unit]!;
  return n * ms;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
