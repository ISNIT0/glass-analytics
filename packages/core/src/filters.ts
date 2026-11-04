/**
 * Property references and filters.
 *
 * One filter language is used everywhere: query filters, breakdowns, and
 * feature-flag targeting. A property is written as a short string:
 *
 * | Written as         | Resolves to                                        |
 * | ------------------ | -------------------------------------------------- |
 * | `browser`, `path`… | a built-in column (see FILTERABLE_COLUMNS)          |
 * | `plan`, `props.plan` | the event property `plan`                        |
 * | `person.plan`      | the person property `plan` at the time of the event |
 * | `props.address.city` | a nested event property                          |
 * | `cohort`           | membership of a saved cohort (value: cohort key)    |
 *
 * `cohort` filters use `eq`/`in` ("in any of these cohorts") or `neq`/`not_in`.
 * The server resolves each key to its saved definition before compiling, so
 * core never reads the cohorts table. An event property literally named
 * "cohort" is still reachable as `props.cohort`.
 */

import { FILTERABLE_COLUMNS } from './events.ts';

export type PropertyRef =
  | { kind: 'column'; column: string }
  | { kind: 'event'; path: string[] }
  | { kind: 'person'; path: string[] };

export const FILTER_OPS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_set',
  'is_not_set',
] as const;

export type FilterOp = (typeof FILTER_OPS)[number];
export type FilterValue = string | number | boolean | (string | number)[];

export interface Filter {
  property: string;
  /** Defaults to `eq`. */
  op?: FilterOp;
  value?: FilterValue;
  /** Resolved definitions for a `cohort` filter, keyed by cohort key. Set by the server, never by callers. */
  cohorts?: Record<string, CohortMembers>;
}

/** Pseudo-property that filters on saved-cohort membership. */
export const COHORT_PROPERTY = 'cohort';

/**
 * Prefix for session-level filters: `session.utm_source = google` keeps every
 * event of sessions with a pageview where utm_source is google. Sources (UTM
 * tags, referrer) are only on the landing pageview, so an event-level filter
 * would drop the rest of the visit, including its conversions.
 */
export const SESSION_PREFIX = 'session.';

/** Who is in a cohort: people with a matching event in [from, to). */
export interface CohortMembers {
  project: string;
  from: number;
  to: number;
  /** Only people who did one of these events. */
  events?: string[];
  filters: Filter[];
}

export function parseProperty(input: string): PropertyRef {
  const raw = input.trim();
  if (!raw) throw new TypeError('Property name cannot be empty');
  if (raw.startsWith('person.')) return { kind: 'person', path: splitPath(raw.slice(7)) };
  if (raw.startsWith('props.')) return { kind: 'event', path: splitPath(raw.slice(6)) };
  if (FILTERABLE_COLUMNS.has(raw)) return { kind: 'column', column: raw };
  return { kind: 'event', path: splitPath(raw) };
}

function splitPath(path: string): string[] {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) throw new TypeError(`Invalid property path "${path}"`);
  return parts;
}

/** Context a feature flag is evaluated against. */
export interface EvaluationContext {
  distinct_id: string;
  user_id?: string | null;
  person?: Record<string, unknown>;
  country?: string;
  device?: string;
  browser?: string;
  os?: string;
  url?: string;
  path?: string;
  host?: string;
  [column: string]: unknown;
}

function lookup(ctx: EvaluationContext, ref: PropertyRef): unknown {
  if (ref.kind === 'column') return ctx[ref.column];
  // Flags have no event properties; `plan` and `person.plan` both mean the person property.
  let value: unknown = ctx.person;
  for (const key of ref.path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const asText = (v: unknown): string | null =>
  v === undefined || v === null || v === ''
    ? null
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v);

/** Evaluate a filter in JavaScript. Mirrors the SQL semantics in `sql/filters.ts`. */
export function matchFilter(filter: Filter, ctx: EvaluationContext): boolean {
  const op = filter.op ?? 'eq';
  const actual = lookup(ctx, parseProperty(filter.property));
  const text = asText(actual);
  const value = filter.value;
  switch (op) {
    case 'is_set':
      return text !== null;
    case 'is_not_set':
      return text === null;
    case 'eq':
      return text !== null && text === asText(value);
    case 'neq':
      return text === null || text !== asText(value);
    case 'contains':
      return text !== null && text.toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'not_contains':
      return text === null || !text.toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'in':
      return text !== null && toList(value).includes(text);
    case 'not_in':
      return text === null || !toList(value).includes(text);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = typeof actual === 'number' ? actual : Number.NaN;
      const b = Number(value);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
  }
}

export function toList(value: FilterValue | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}
