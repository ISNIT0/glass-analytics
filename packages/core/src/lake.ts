/**
 * Lake mode table definitions: the Pipelines stream schemas that become the
 * Iceberg tables Basin SQL queries. Shared by the CLI (which creates streams)
 * and the Worker (which writes to them).
 *
 * Schemas are versioned. A Pipelines stream's schema can't change, and a sink
 * can't write to a table it didn't create, so a new column means a new table:
 * version 2 of `events` is `events_v2`, with its own stream, sink and pipeline
 * (`dataflare upgrade` creates them and points the Worker at them). Old tables
 * stay; queries read every version through a UNION ALL, with NULL for columns an
 * older version lacks (see `lakeTableSql`). To change a schema, add an entry to
 * LAKE_SCHEMA_CHANGES and bump LAKE_VERSION. Stream names are per deployment
 * (`<name>_events`, `<name>_events_v2`; see lakeResourceNames in the CLI).
 */

import { EVENT_COLUMNS } from './events.ts';

export interface StreamField {
  name: string;
  type: 'string' | 'int64' | 'float64' | 'bool' | 'timestamp';
  required: boolean;
}

const INTEGER_COLUMNS = new Set(['ts_ms', 'received_ms']);
const OPTIONAL_COLUMNS = new Set(['user_id']);

export const LAKE_TABLES = {
  events: {
    fields: [
      ...EVENT_COLUMNS.map(
        (name): StreamField => ({
          name,
          type: INTEGER_COLUMNS.has(name) ? 'int64' : 'string',
          required: !OPTIONAL_COLUMNS.has(name),
        }),
      ),
      { name: 'ts', type: 'timestamp', required: true },
    ],
  },
  identities: {
    fields: [
      { name: 'project', type: 'string', required: true },
      { name: 'distinct_id', type: 'string', required: true },
      { name: 'person_id', type: 'string', required: true },
      { name: 'created_at', type: 'int64', required: true },
    ] satisfies StreamField[],
  },
} as const;

export type LakeTable = keyof typeof LAKE_TABLES;

/** One schema change: the columns a table version adds (always optional, so older rows read as NULL). */
export interface LakeSchemaChange {
  version: number;
  table: LakeTable;
  add: StreamField[];
}

/** Every schema change since version 1, oldest first. Empty: all deployments are on version 1. */
export const LAKE_SCHEMA_CHANGES: readonly LakeSchemaChange[] = [];

/** The version new lake deployments are created at, and upgrades move to. */
export const LAKE_VERSION = Math.max(1, ...LAKE_SCHEMA_CHANGES.map((c) => c.version));

/** The fields of a table at a version. */
export function lakeFields(
  table: LakeTable,
  version: number,
  changes: readonly LakeSchemaChange[] = LAKE_SCHEMA_CHANGES,
): StreamField[] {
  return [
    ...LAKE_TABLES[table].fields,
    ...changes
      .filter((c) => c.table === table && c.version <= version)
      .flatMap((c) => c.add.map((f) => ({ ...f, required: false }))),
  ];
}

/** The Iceberg table holding a version: `events` for version 1, `events_v2` after. */
export function lakeTableName(table: LakeTable, version: number): string {
  return version <= 1 ? table : `${table}_v${version}`;
}

/** The JSON schema file `wrangler pipelines streams create --schema-file` expects. */
export function streamSchemaFile(
  table: LakeTable,
  version = 1,
  changes: readonly LakeSchemaChange[] = LAKE_SCHEMA_CHANGES,
): { fields: StreamField[] } {
  return { fields: lakeFields(table, version, changes) };
}

const SQL_TYPES: Record<StreamField['type'], string> = {
  string: 'VARCHAR',
  int64: 'BIGINT',
  float64: 'DOUBLE',
  bool: 'BOOLEAN',
  timestamp: 'TIMESTAMP',
};

/**
 * What queries read for a table: the table itself when one version exists, otherwise a UNION ALL
 * of every version projected to the newest schema, with NULL for the columns older versions lack.
 */
export function lakeTableSql(
  namespace: string,
  table: LakeTable,
  versions: readonly number[],
  changes: readonly LakeSchemaChange[] = LAKE_SCHEMA_CHANGES,
): string {
  const list = [...new Set(versions.length ? versions : [1])].sort((a, b) => a - b);
  if (list.length === 1) return `${namespace}.${lakeTableName(table, list[0]!)}`;
  const latest = lakeFields(table, list.at(-1)!, changes);
  const parts = list.map((v) => {
    const has = new Set(lakeFields(table, v, changes).map((f) => f.name));
    const cols = latest.map((f) =>
      has.has(f.name) ? f.name : `CAST(NULL AS ${SQL_TYPES[f.type]}) AS ${f.name}`,
    );
    return `SELECT ${cols.join(', ')} FROM ${namespace}.${lakeTableName(table, v)}`;
  });
  return `(${parts.join(' UNION ALL ')})`;
}

/** Parse the LAKE_VERSIONS Worker variable ("1,2"): the table versions queries read. */
export function parseLakeVersions(value: string | undefined): number[] {
  const list = (value ?? '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v >= 1);
  return list.length ? list : [1];
}
