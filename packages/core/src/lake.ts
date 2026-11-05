/**
 * Lake mode table definitions: the Pipelines stream schemas that become the
 * Iceberg tables Basin SQL queries. Shared by the CLI (which creates streams)
 * and the Worker (which writes to them).
 *
 * Pipelines stream schemas cannot be changed after creation, so treat these as
 * versioned: a change needs new streams (e.g. `glass_events_v2`) and a
 * migration step in `dataflare upgrade`.
 */

import { EVENT_COLUMNS } from './events.ts';

export interface StreamField {
  name: string;
  type: 'string' | 'int64' | 'float64' | 'bool' | 'timestamp';
  required: boolean;
}

const INTEGER_COLUMNS = new Set(['ts_ms', 'received_ms']);
const OPTIONAL_COLUMNS = new Set(['user_id']);

export const LAKE_VERSION = 1;

export const LAKE_TABLES = {
  events: {
    stream: 'glass_events',
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
    stream: 'glass_identities',
    fields: [
      { name: 'project', type: 'string', required: true },
      { name: 'distinct_id', type: 'string', required: true },
      { name: 'person_id', type: 'string', required: true },
      { name: 'created_at', type: 'int64', required: true },
    ] satisfies StreamField[],
  },
} as const;

export type LakeTable = keyof typeof LAKE_TABLES;

/** The JSON schema file `wrangler pipelines streams create --schema-file` expects. */
export function streamSchemaFile(table: LakeTable): { fields: StreamField[] } {
  return { fields: [...LAKE_TABLES[table].fields] };
}
