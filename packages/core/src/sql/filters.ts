/**
 * Compile property references and filters to SQL.
 *
 * Every value is inlined as an escaped literal (Basin SQL's HTTP API has no
 * parameter binding), and every property key is validated by the dialect, so
 * user input can never change the shape of a query.
 */

import {
  COHORT_PROPERTY,
  type Filter,
  type PropertyRef,
  parseProperty,
  toList,
} from '../filters.ts';
import type { Dialect } from './dialect.ts';
import { cohortMembersSql } from './source.ts';

/** Prefix a column with a table alias when one is given. */
const col = (name: string, alias?: string) => (alias ? `${alias}.${name}` : name);

/** A property as a text expression (used for equality, breakdowns, display). */
export function propertyText(ref: PropertyRef | string, d: Dialect, alias?: string): string {
  const r = typeof ref === 'string' ? parseProperty(ref) : ref;
  if (r.kind === 'column') return col(r.column, alias);
  return d.jsonText(col(r.kind === 'person' ? 'person_props' : 'props', alias), r.path);
}

/** A property as a numeric expression (used for sum/avg and numeric comparisons). */
export function propertyNumber(ref: PropertyRef | string, d: Dialect, alias?: string): string {
  const r = typeof ref === 'string' ? parseProperty(ref) : ref;
  if (r.kind === 'column') {
    throw new TypeError(
      `"${r.column}" is a text column; numeric operations need an event or person property.`,
    );
  }
  return d.jsonNumber(col(r.kind === 'person' ? 'person_props' : 'props', alias), r.path);
}

/**
 * A breakdown expression: one or more properties as text, missing values as
 * "(none)". Multiple properties are joined with " · " (e.g. "Chrome · google").
 */
export function breakdownExpr(
  property: string | readonly string[],
  d: Dialect,
  alias?: string,
): string {
  const props = (Array.isArray(property) ? property : [property])
    .map((p) => p.trim())
    .filter(Boolean);
  if (props.length === 0) return `'(none)'`;
  const parts = props.map((p) => `COALESCE(NULLIF(${propertyText(p, d, alias)}, ''), '(none)')`);
  if (parts.length === 1) return parts[0]!;
  return parts.join(` || ' · ' || `);
}

/** Normalize a single string or list of breakdown properties. */
export function breakdownProperties(
  breakdown: string | readonly string[] | undefined | null,
): string[] {
  if (!breakdown) return [];
  return (Array.isArray(breakdown) ? [...breakdown] : [breakdown])
    .map((p) => p.trim())
    .filter(Boolean);
}

export function filterSql(filter: Filter, d: Dialect, alias?: string): string {
  if (filter.property === COHORT_PROPERTY) return cohortFilterSql(filter, d, alias);
  const ref = parseProperty(filter.property);
  const op = filter.op ?? 'eq';
  const value = filter.value;
  const text = propertyText(ref, d, alias);
  const isSet =
    ref.kind === 'column'
      ? `(${text} IS NOT NULL AND ${text} <> '')`
      : d.jsonExists(col(ref.kind === 'person' ? 'person_props' : 'props', alias), ref.path);

  const need = (what: string) => {
    if (value === undefined || value === null) {
      throw new TypeError(`Filter on "${filter.property}" with op "${op}" needs a ${what} value.`);
    }
  };

  switch (op) {
    case 'is_set':
      return isSet;
    case 'is_not_set':
      return `NOT ${isSet}`;
    case 'eq':
    case 'neq': {
      need('value');
      let cond: string;
      if (typeof value === 'boolean' && ref.kind !== 'column') {
        cond = `${d.jsonBool(col(ref.kind === 'person' ? 'person_props' : 'props', alias), ref.path)} = ${d.bool(value)}`;
      } else if (typeof value === 'number' && ref.kind !== 'column') {
        cond = `${propertyNumber(ref, d, alias)} = ${d.num(value)}`;
      } else {
        cond = `${text} = ${d.str(String(value))}`;
      }
      return op === 'eq' ? `(${cond})` : `(${text} IS NULL OR NOT (${cond}))`;
    }
    case 'contains':
      need('text');
      return d.containsIgnoreCase(text, String(value));
    case 'not_contains':
      need('text');
      return `(${text} IS NULL OR NOT ${d.containsIgnoreCase(text, String(value))})`;
    case 'in':
    case 'not_in': {
      const list = toList(value);
      if (list.length === 0)
        throw new TypeError(`Filter "${filter.property}" with op "${op}" needs a non-empty list.`);
      const inList = `${text} IN (${list.map((v) => d.str(v)).join(', ')})`;
      return op === 'in' ? `(${inList})` : `(${text} IS NULL OR NOT ${inList})`;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      need('numeric');
      const n = Number(value);
      if (!Number.isFinite(n))
        throw new TypeError(`Filter "${filter.property}" with op "${op}" needs a number.`);
      const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      return `(${propertyNumber(ref, d, alias)} ${sym} ${d.num(n)})`;
    }
    default:
      throw new TypeError(`Unknown filter op "${String(op)}".`);
  }
}

/** Saved-cohort membership, tested on the resolved person id (`pid`, from `eventsCte`). */
function cohortFilterSql(filter: Filter, d: Dialect, alias?: string): string {
  const op = filter.op ?? 'eq';
  if (op !== 'eq' && op !== 'in' && op !== 'neq' && op !== 'not_in') {
    throw new TypeError(`Cohort filters use "eq"/"in" or "neq"/"not_in", not "${op}".`);
  }
  const keys = toList(filter.value);
  if (keys.length === 0) throw new TypeError('A cohort filter needs a cohort key as its value.');
  const members = keys.map((key) => {
    const c = filter.cohorts?.[key];
    if (!c)
      throw new TypeError(
        `Cohort "${key}" was not resolved. Run the query through the Glass API, which loads saved cohorts.`,
      );
    return `${col('pid', alias)} IN (${cohortMembersSql(d, c)})`;
  });
  const any = `(${members.join(' OR ')})`;
  return op === 'eq' || op === 'in' ? any : `(NOT ${any})`;
}

/** AND together a list of filters. Returns `1 = 1` when empty so it can always be spliced into a WHERE. */
export function filtersSql(
  filters: readonly Filter[] | undefined,
  d: Dialect,
  alias?: string,
): string {
  if (!filters || filters.length === 0) return '1 = 1';
  return filters.map((f) => filterSql(f, d, alias)).join(' AND ');
}
