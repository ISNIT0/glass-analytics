/**
 * Cohorts: saved groups of people, defined by what they are and what they did.
 *
 * A definition is groups of conditions: the person must match all (or any) of
 * the groups, and within a group all (or any) of its conditions. Conditions:
 *
 * | type                 | matches people who…                                              |
 * | -------------------- | ---------------------------------------------------------------- |
 * | property             | have a person (or event) property value in the look-back         |
 * | performed            | did an event at least / exactly / at most N times within a window |
 * | not_performed        | didn't do it within the window                                    |
 * | performed_regularly  | did it in at least K of the last N days, weeks or months          |
 * | first_performed      | did it for the first time ever within the window                  |
 * | stopped              | did it in the window before, but not in the latest one            |
 * | started              | did it in the latest window, but not in the one before            |
 * | sequence             | did one event and then another within a gap                       |
 * | cohort               | are (or aren't) in another saved cohort                           |
 *
 * Every condition compiles to a subquery of person ids (`pid`), so a cohort
 * works as a filter on any insight in both stores. Static cohorts (uploaded or
 * saved from a list of people) have explicit members instead; the service says
 * how to read them (a D1 table, or inlined ids in the lake).
 */

import { z } from 'zod/v4';
import type { Filter } from './filters.ts';
import { filterSchema } from './insights/schemas.ts';
import type { Dialect } from './sql/dialect.ts';
import { filtersSql } from './sql/filters.ts';
import { bucketExpr, resolvedEventsSql } from './sql/source.ts';
import { DAY_MS, parseDuration, parseTime } from './time.ts';

const duration = z
  .union([z.string(), z.number()])
  .describe('A length of time back from now, e.g. "30d", "2w", "6mo" (or seconds).');

const behaviour = {
  event: z.string().describe('Event name, or "*" for any event.'),
  filters: z.array(filterSchema).optional().describe('Conditions on that event.'),
};

export const cohortCondition = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('property'),
    property: z.string().describe('A person property ("person.plan"), event property or column.'),
    op: filterSchema.shape.op,
    value: filterSchema.shape.value,
    negate: z.boolean().optional().describe('People who do NOT match.'),
  }),
  z.object({
    type: z.literal('performed'),
    ...behaviour,
    count: z
      .object({
        op: z.enum(['gte', 'eq', 'lte']).describe('At least, exactly, or at most.'),
        value: z.number().int().min(0),
      })
      .optional()
      .describe('How many times. Default: at least once.'),
    within: duration.optional().describe('Window back from now. Default "30d".'),
  }),
  z.object({
    type: z.literal('not_performed'),
    ...behaviour,
    within: duration.optional().describe('Window back from now. Default "30d".'),
  }),
  z.object({
    type: z.literal('performed_regularly'),
    ...behaviour,
    period: z.enum(['day', 'week', 'month']),
    periods: z.number().int().min(1).max(52).describe('How many recent periods to look at.'),
    minPeriods: z.number().int().min(1).describe('In at least this many of them.'),
  }),
  z.object({
    type: z.literal('first_performed'),
    ...behaviour,
    within: duration
      .optional()
      .describe('Their first time ever was within this window. Default "30d".'),
  }),
  z.object({
    type: z.literal('stopped'),
    ...behaviour,
    within: duration.describe('The recent window they did NOT do it in, e.g. "14d".'),
    before: duration
      .optional()
      .describe('The window before it they DID do it in. Default the same length.'),
  }),
  z.object({
    type: z.literal('started'),
    ...behaviour,
    within: duration.describe('The recent window they did it in, e.g. "7d".'),
    before: duration
      .optional()
      .describe('The window before it they did NOT do it in. Default the same length.'),
  }),
  z.object({
    type: z.literal('sequence'),
    ...behaviour,
    followedBy: z.object(behaviour).describe('The event that must follow.'),
    gap: duration.optional().describe('At most this long between them. Default "1d".'),
    within: duration.optional().describe('Both within this window. Default "30d".'),
  }),
  z.object({
    type: z.literal('cohort'),
    key: z.string().describe('Another saved cohort.'),
    negate: z.boolean().optional().describe('People NOT in it.'),
  }),
]);

export type CohortCondition = z.infer<typeof cohortCondition>;

export const cohortGroup = z.object({
  match: z.enum(['all', 'any']).optional().describe('Match all conditions (default) or any.'),
  conditions: z.array(cohortCondition).min(1).max(20),
});

export const cohortDefinitionV2 = z
  .object({
    match: z.enum(['all', 'any']).optional().describe('Match all groups (default) or any.'),
    groups: z.array(cohortGroup).min(1).max(10),
    from: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'How far back people are considered at all (and property conditions look). Default "-90d".',
      ),
  })
  .describe('Groups of conditions; see docs/queries.md#cohorts.');

export type CohortDefinition = z.infer<typeof cohortDefinitionV2>;

/** A version-1 definition: filters on events in a look-back, optionally on one event. */
export interface LegacyCohortDefinition {
  filters?: Filter[];
  didEvent?: string;
  from?: string | number;
}

/** Read any stored definition as version 2. */
export function normaliseCohort(raw: unknown, now = Date.now()): CohortDefinition {
  const v2 = cohortDefinitionV2.safeParse(raw);
  if (v2.success) return v2.data;
  // Version 1 meant: people with an event (of `didEvent`, if set) in the look-back that matches
  // every filter. That is one "performed" condition with those filters on the same event.
  const old = (raw ?? {}) as LegacyCohortDefinition;
  const from = old.from ?? '-90d';
  return {
    match: 'all',
    groups: [
      {
        match: 'all',
        conditions: [
          {
            type: 'performed',
            event: old.didEvent || '*',
            ...(old.filters?.length ? { filters: old.filters } : {}),
            within: lookbackSeconds(from, now),
          },
        ],
      },
    ],
    from,
  };
}

/** A v1 look-back ("-90d", an ISO date) as seconds back from now, for the equivalent condition. */
function lookbackSeconds(from: string | number | undefined, now = Date.now()): number {
  const start = parseTime(from ?? '-90d', now);
  return Math.max(1, Math.round((now - start) / 1000));
}

export interface CohortContext {
  dialect: Dialect;
  project: string;
  now: number;
  /** Another saved cohort's definition, or "static" for a cohort with explicit members. */
  lookup(key: string): CohortDefinition | 'static' | undefined;
  /** SQL selecting `pid` for a static cohort's members. */
  staticMembers(key: string): string;
}

/** Membership as SQL selecting `pid`. Throws on unknown or circular references. */
export function compileCohort(
  def: CohortDefinition,
  ctx: CohortContext,
  stack: string[] = [],
): string {
  const d = ctx.dialect;
  const now = ctx.now;
  const universeFrom = parseTime(def.from ?? '-90d', now);
  const windows: number[] = [universeFrom];
  const events = (from: number, to: number, b: { event: string; filters?: Filter[] }) =>
    resolvedEventsSql(d, {
      project: ctx.project,
      from,
      to,
      events: b.event === '*' ? undefined : [b.event],
      filters: b.filters as Filter[] | undefined,
    });
  const back = (v: string | number | undefined, fallback: string) =>
    now - parseDuration(v ?? fallback);

  const conditionSql = (c: CohortCondition): { sql: string; negate: boolean } => {
    switch (c.type) {
      case 'property': {
        const filter = { property: c.property, op: c.op, value: c.value } as Filter;
        return {
          sql: `SELECT DISTINCT cp.pid FROM (${resolvedEventsSql(d, { project: ctx.project, from: universeFrom, to: now + 60_000 })}) cp WHERE ${filtersSql([filter], d, 'cp')}`,
          negate: Boolean(c.negate),
        };
      }
      case 'performed': {
        const from = back(c.within, '30d');
        windows.push(from);
        const count = c.count ?? { op: 'gte' as const, value: 1 };
        if (count.op === 'gte' && count.value <= 0) {
          return {
            sql: `SELECT DISTINCT pe.pid FROM (${events(universeFrom, now + 60_000, { event: '*' })}) pe`,
            negate: false,
          };
        }
        const sym = { gte: '>=', eq: '=', lte: '<=' }[count.op];
        // "At most N" (or exactly 0) includes people who never did it.
        if ((count.op === 'lte' && count.value >= 0) || (count.op === 'eq' && count.value === 0)) {
          const over = count.op === 'eq' ? 0 : count.value;
          return {
            sql: `SELECT pe.pid FROM (${events(from, now + 60_000, c)}) pe GROUP BY pe.pid HAVING COUNT(*) > ${d.num(over)}`,
            negate: true,
          };
        }
        return {
          sql: `SELECT pe.pid FROM (${events(from, now + 60_000, c)}) pe GROUP BY pe.pid HAVING COUNT(*) ${sym} ${d.num(count.value)}`,
          negate: false,
        };
      }
      case 'not_performed': {
        const from = back(c.within, '30d');
        windows.push(from);
        return {
          sql: `SELECT DISTINCT pe.pid FROM (${events(from, now + 60_000, c)}) pe`,
          negate: true,
        };
      }
      case 'performed_regularly': {
        if (c.minPeriods > c.periods)
          throw new RangeError('minPeriods cannot be more than periods.');
        const unit = c.period === 'day' ? DAY_MS : c.period === 'week' ? 7 * DAY_MS : 30 * DAY_MS;
        const from = now - c.periods * unit;
        windows.push(from);
        return {
          sql: `SELECT pr.pid FROM (SELECT DISTINCT pe.pid, ${bucketExpr(d, 'pe.ts_ms', c.period)} AS b FROM (${events(from, now + 60_000, c)}) pe) pr GROUP BY pr.pid HAVING COUNT(*) >= ${d.num(c.minPeriods)}`,
          negate: false,
        };
      }
      case 'first_performed': {
        const from = back(c.within, '30d');
        windows.push(from);
        // First ever: all history, not just the window.
        return {
          sql: `SELECT pe.pid FROM (${events(0, now + 60_000, c)}) pe GROUP BY pe.pid HAVING MIN(pe.ts_ms) >= ${d.num(from)}`,
          negate: false,
        };
      }
      case 'stopped':
      case 'started': {
        const recent = parseDuration(c.within);
        const prior = parseDuration(c.before ?? c.within);
        const split = now - recent;
        const start = split - prior;
        windows.push(start);
        const before = `SELECT DISTINCT pe.pid FROM (${events(start, split, c)}) pe`;
        const after = `SELECT DISTINCT pe.pid FROM (${events(split, now + 60_000, c)}) pe`;
        const [did, didNot] = c.type === 'stopped' ? [before, after] : [after, before];
        return {
          sql: `SELECT dn.pid FROM (${did}) dn WHERE dn.pid NOT IN (${didNot})`,
          negate: false,
        };
      }
      case 'sequence': {
        const from = back(c.within, '30d');
        const gap = parseDuration(c.gap ?? '1d');
        windows.push(from);
        return {
          sql: `SELECT DISTINCT sa.pid FROM (${events(from, now + 60_000, c)}) sa JOIN (${events(from, now + 60_000, c.followedBy)}) sb
  ON sb.pid = sa.pid AND sb.ts_ms > sa.ts_ms AND sb.ts_ms <= sa.ts_ms + ${d.num(gap)}`,
          negate: false,
        };
      }
      case 'cohort': {
        if (stack.includes(c.key)) {
          throw new TypeError(
            `Cohorts refer to each other in a loop: ${[...stack, c.key].join(' → ')}.`,
          );
        }
        const other = ctx.lookup(c.key);
        if (other === undefined) throw new TypeError(`No cohort "${c.key}" to refer to.`);
        const sql =
          other === 'static'
            ? ctx.staticMembers(c.key)
            : compileCohort(other, ctx, [...stack, c.key]);
        return { sql, negate: Boolean(c.negate) };
      }
    }
  };

  const groups = def.groups.map((g) => {
    const parts = g.conditions.map((c) => {
      const { sql, negate } = conditionSql(c);
      return `u.pid ${negate ? 'NOT IN' : 'IN'} (${sql})`;
    });
    return `(${parts.join(g.match === 'any' ? ' OR ' : ' AND ')})`;
  });
  // Everyone seen in the longest window any condition looks at: "did not" needs someone to not do it.
  const universe = `SELECT DISTINCT ue.pid FROM (${resolvedEventsSql(d, { project: ctx.project, from: Math.min(...windows), to: now + 60_000 })}) ue`;
  return `SELECT u.pid FROM (${universe}) u WHERE ${groups.join(def.match === 'any' ? ' OR ' : ' AND ')}`;
}

/** Keys of the other cohorts a definition refers to (for listings and cycle checks). */
export function cohortReferences(def: CohortDefinition): string[] {
  return def.groups.flatMap((g) =>
    g.conditions.flatMap((c) => (c.type === 'cohort' ? [c.key] : [])),
  );
}

/** A one-line description of a definition, for summaries. */
const OP_WORDS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is any of',
  not_in: 'is none of',
  contains: 'contains',
  not_contains: "doesn't contain",
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  is_set: 'is set',
  is_not_set: 'is not set',
};

const UNIT_WORDS: Record<string, string> = {
  s: 'second',
  m: 'minute',
  min: 'minute',
  h: 'hour',
  d: 'day',
  w: 'week',
  mo: 'month',
};

/** "30d" → "30 days", "1w" → "1 week"; anything else as given (seconds as "N seconds"). */
export function durationWords(input: string | number): string {
  if (typeof input === 'number') return `${input} second${input === 1 ? '' : 's'}`;
  const m = /^(\d+)\s*(s|m|min|h|d|w|mo)$/i.exec(input.trim());
  if (!m) return input;
  const n = Number(m[1]);
  return `${n} ${UNIT_WORDS[m[2]!.toLowerCase()]}${n === 1 ? '' : 's'}`;
}

const COUNT_WORDS = { gte: 'at least', eq: 'exactly', lte: 'at most' } as const;

/**
 * A definition in plain words, e.g. "did report at least 3 times in the last 7 days".
 * `names` turns referenced cohort keys into their names.
 */
export function describeCohort(def: CohortDefinition, names?: Map<string, string>): string {
  const value = (v: unknown) =>
    v === undefined
      ? ''
      : ` ${Array.isArray(v) ? v.map((x) => JSON.stringify(x)).join(', ') : JSON.stringify(v)}`;
  const one = (c: CohortCondition): string => {
    switch (c.type) {
      case 'property': {
        const op = c.op ?? 'eq';
        return `${c.negate ? 'not: ' : ''}${c.property} ${OP_WORDS[op] ?? op}${op === 'is_set' || op === 'is_not_set' ? '' : value(c.value)}`;
      }
      case 'performed':
        return `did ${c.event}${c.count ? ` ${COUNT_WORDS[c.count.op]} ${c.count.value} time${c.count.value === 1 ? '' : 's'}` : ''} in the last ${durationWords(c.within ?? '30d')}`;
      case 'not_performed':
        return `didn't do ${c.event} in the last ${durationWords(c.within ?? '30d')}`;
      case 'performed_regularly':
        return `did ${c.event} in at least ${c.minPeriods} of the last ${c.periods} ${c.period}s`;
      case 'first_performed':
        return `first did ${c.event} in the last ${durationWords(c.within ?? '30d')}`;
      case 'stopped':
        return `stopped doing ${c.event} (none in the last ${durationWords(c.within)})`;
      case 'started':
        return `started doing ${c.event} (in the last ${durationWords(c.within)})`;
      case 'sequence':
        return `did ${c.event} then ${c.followedBy.event} within ${durationWords(c.gap ?? '1d')}`;
      case 'cohort': {
        const name = names?.get(c.key);
        return `${c.negate ? 'not in' : 'in'} cohort ${name ? `"${name}"` : c.key}`;
      }
    }
  };
  return def.groups
    .map((g) => g.conditions.map(one).join(g.match === 'any' ? ' or ' : ' and '))
    .map((s) => (def.groups.length > 1 ? `(${s})` : s))
    .join(def.match === 'any' ? ' or ' : ' and ');
}
