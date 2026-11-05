import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LAKE_TABLES,
  LAKE_VERSION,
  type LakeSchemaChange,
  lakeFields,
  lakeTableName,
  lakeTableSql,
  parseLakeVersions,
  streamSchemaFile,
} from '../src/lake.ts';
import { basin } from '../src/sql/dialect.ts';

const V2: LakeSchemaChange[] = [
  { version: 2, table: 'events', add: [{ name: 'locale', type: 'string', required: true }] },
];

describe('lake schema versions', () => {
  it('starts every deployment on version 1 until a change is added', () => {
    assert.equal(LAKE_VERSION, 1);
    assert.deepEqual(lakeFields('events', 1), LAKE_TABLES.events.fields);
    assert.equal(lakeTableName('events', 1), 'events');
    assert.equal(lakeTableSql('glass', 'events', [1]), 'glass.events');
    assert.equal(basin('glass').table('events'), 'glass.events');
  });

  it('adds columns as optional in later versions only', () => {
    const v2 = lakeFields('events', 2, V2);
    assert.deepEqual(v2.at(-1), { name: 'locale', type: 'string', required: false });
    assert.equal(lakeFields('events', 1, V2).length, LAKE_TABLES.events.fields.length);
    assert.deepEqual(lakeFields('identities', 2, V2), LAKE_TABLES.identities.fields);
    assert.equal(lakeTableName('events', 2), 'events_v2');
    assert.deepEqual(
      streamSchemaFile('events', 2, V2)
        .fields.map((f) => f.name)
        .slice(-2),
      ['ts', 'locale'],
    );
  });

  it('reads every version through a UNION ALL, with NULL for columns older tables lack', () => {
    const sql = lakeTableSql('glass', 'events', [2, 1], V2);
    assert.match(
      sql,
      /^\(SELECT .* FROM glass\.events UNION ALL SELECT .* FROM glass\.events_v2\)$/,
    );
    assert.match(sql, /CAST\(NULL AS VARCHAR\) AS locale FROM glass\.events UNION/);
    assert.match(sql, /, locale FROM glass\.events_v2\)$/);
    // A deployment created on version 2 has only the new table.
    assert.equal(lakeTableSql('glass', 'events', [2], V2), 'glass.events_v2');
    assert.equal(basin('glass', [1, 2], V2).table('events'), sql);
  });

  it('parses LAKE_VERSIONS', () => {
    assert.deepEqual(parseLakeVersions(undefined), [1]);
    assert.deepEqual(parseLakeVersions('1, 2'), [1, 2]);
    assert.deepEqual(parseLakeVersions('nonsense'), [1]);
  });
});
