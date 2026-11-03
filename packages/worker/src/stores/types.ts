/**
 * Event stores.
 *
 * An EventStore is where events are written and how SQL against them is run.
 * Glass ships two:
 *
 * - `D1Store` (default): events in the same D1 database as everything else.
 *   Free-plan friendly, real-time, simple. Good to a few million events a month.
 * - `LakeStore`: events streamed through Cloudflare Pipelines into Iceberg
 *   tables in R2, queried with Basin SQL. Unbounded history, open format,
 *   ~1-5 minutes of ingest delay.
 *
 * Both expose the same `events` / `identities` columns, so every insight
 * compiler works unchanged. To add a backend (ClickHouse, Tinybird, DuckDB…)
 * implement this interface and a `Dialect`; see docs/extending.md.
 */

import type { StoredEvent } from '@glass/core/events';
import type { Row } from '@glass/core/insights/types';
import type { Dialect } from '@glass/core/sql/dialect';

export interface IdentityLink {
  project: string;
  distinct_id: string;
  person_id: string;
  created_at: number;
}

export interface EventStore {
  readonly kind: string;
  readonly dialect: Dialect;
  /** Roughly how long until written events are queryable. */
  readonly freshnessSeconds: number;
  write(events: StoredEvent[]): Promise<void>;
  /** Mirror a new identity link into the store (D1 already has it). */
  writeIdentity(link: IdentityLink): Promise<void>;
  /** Run one read-only statement. */
  query(sql: string): Promise<Row[]>;
  /** Delete every event of these persons/devices. Returns false when the store can't delete. */
  deletePersonEvents(project: string, ids: string[]): Promise<boolean>;
}
