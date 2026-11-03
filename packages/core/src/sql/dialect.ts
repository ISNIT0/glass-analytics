/**
 * SQL dialects.
 *
 * Glass compiles every query (trends, funnels, retention, web stats, experiment
 * results) to SQL that runs on two engines:
 *
 * - `sqlite`: Cloudflare D1, the default event store (and the test suite).
 * - `basin`:  Basin SQL (formerly R2 SQL), DataFusion over Iceberg tables in R2,
 *             used by the opt-in "lake" store.
 *
 * The compilers are written so that almost everything is plain, portable SQL:
 * timestamps are integer milliseconds (`ts_ms`), so bucketing is integer
 * arithmetic, and only the handful of operations below differ by engine. That is
 * deliberate: the SQLite tests exercise the same query logic the lake runs.
 *
 * Adding an engine (ClickHouse, DuckDB, Postgres…) means implementing this
 * interface — see docs/extending.md.
 */

export type DialectName = 'sqlite' | 'basin';

/** Tables the compilers read. */
export type TableName = 'events' | 'identities';

export interface Dialect {
  readonly name: DialectName;
  /** Fully qualified table reference. */
  table(name: TableName): string;
  /** A string literal, safely escaped. */
  str(value: string): string;
  /** A numeric literal. Throws on NaN/Infinity rather than emitting broken SQL. */
  num(value: number): string;
  /** A boolean literal. */
  bool(value: boolean): string;
  /** The JSON value at `path` as text (strings unquoted, booleans as "true"/"false"), NULL when missing. */
  jsonText(column: string, path: readonly string[]): string;
  /** The JSON value at `path` as a number, NULL when missing or not numeric. */
  jsonNumber(column: string, path: readonly string[]): string;
  /** The JSON value at `path` as a boolean, NULL when missing or not boolean. */
  jsonBool(column: string, path: readonly string[]): string;
  /** TRUE when `path` exists in the JSON document. */
  jsonExists(column: string, path: readonly string[]): string;
  /** Case-insensitive substring test. No wildcard escaping needed. */
  containsIgnoreCase(expr: string, needle: string): string;
  /** `year * 12 + (month - 1)` for an epoch-milliseconds expression. */
  monthIndex(tsMs: string): string;
  /** Epoch milliseconds of the start of the month for an epoch-milliseconds expression. */
  monthStartMs(tsMs: string): string;
}

/** Characters allowed in property keys. Excluding quotes and backslashes keeps JSON paths injection-proof. */
const SAFE_KEY = /^[^"'\\\u0000-\u001f]{1,200}$/;

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key)) {
    throw new TypeError(
      `Invalid property key "${key}". Keys must be 1-200 characters and cannot contain quotes or backslashes.`,
    );
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`Expected a finite number, got ${value}`);
  return String(value);
}

/** Cloudflare D1 / SQLite. */
export const sqlite: Dialect = {
  name: 'sqlite',
  table: (name) => name,
  str: sqlString,
  num: sqlNumber,
  bool: (v) => (v ? '1' : '0'),
  jsonText(column, path) {
    const p = sqlitePath(path);
    return `(CASE json_type(${column}, ${p}) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL ELSE CAST(json_extract(${column}, ${p}) AS TEXT) END)`;
  },
  jsonNumber(column, path) {
    const p = sqlitePath(path);
    return `(CASE WHEN json_type(${column}, ${p}) IN ('integer', 'real') THEN json_extract(${column}, ${p}) END)`;
  },
  jsonBool(column, path) {
    const p = sqlitePath(path);
    return `(CASE json_type(${column}, ${p}) WHEN 'true' THEN 1 WHEN 'false' THEN 0 END)`;
  },
  jsonExists: (column, path) => `(json_type(${column}, ${sqlitePath(path)}) IS NOT NULL)`,
  containsIgnoreCase: (expr, needle) => `(instr(lower(${expr}), lower(${sqlString(needle)})) > 0)`,
  monthIndex: (ts) =>
    `(CAST(strftime('%Y', (${ts}) / 1000, 'unixepoch') AS INTEGER) * 12 + CAST(strftime('%m', (${ts}) / 1000, 'unixepoch') AS INTEGER) - 1)`,
  monthStartMs: (ts) => `(CAST(strftime('%s', (${ts}) / 1000, 'unixepoch', 'start of month') AS INTEGER) * 1000)`,
};

function sqlitePath(path: readonly string[]): string {
  for (const key of path) assertSafeKey(key);
  return sqlString(`$${path.map((k) => `."${k}"`).join('')}`);
}

/**
 * Basin SQL (Cloudflare's DataFusion-based engine over Iceberg in R2).
 * JSON functions: https://developers.cloudflare.com/basin-sql/sql-reference/scalar-functions/
 */
export function basin(namespace = 'glass'): Dialect {
  if (!/^[a-z_][a-z0-9_]*$/i.test(namespace)) throw new TypeError(`Invalid namespace "${namespace}"`);
  const args = (column: string, path: readonly string[]) => {
    for (const key of path) assertSafeKey(key);
    return [column, ...path.map(sqlString)].join(', ');
  };
  return {
    name: 'basin',
    table: (name) => `${namespace}.${name}`,
    str: sqlString,
    num: sqlNumber,
    bool: (v) => (v ? 'TRUE' : 'FALSE'),
    jsonText: (column, path) => `json_as_text(${args(column, path)})`,
    jsonNumber: (column, path) => `json_get_float(${args(column, path)})`,
    jsonBool: (column, path) => `json_get_bool(${args(column, path)})`,
    jsonExists: (column, path) => `json_contains(${args(column, path)})`,
    containsIgnoreCase: (expr, needle) => `(strpos(lower(${expr}), lower(${sqlString(needle)})) > 0)`,
    monthIndex: (ts) =>
      `(CAST(date_part('year', to_timestamp_millis(${ts})) AS INT) * 12 + CAST(date_part('month', to_timestamp_millis(${ts})) AS INT) - 1)`,
    monthStartMs: (ts) => `(to_unixtime(date_trunc('month', to_timestamp_millis(${ts}))) * 1000)`,
  };
}
