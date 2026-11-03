/**
 * A guard for user-supplied SQL (the `sql` tool and `glass sql`).
 *
 * In lake mode Basin SQL is read-only by construction. D1 is not: the events
 * table shares a database with flags and experiments, so raw SQL must be
 * restricted to a single read-only statement. The check strips literals and
 * comments, then rejects any statement that is not a SELECT/WITH or that contains
 * a write keyword anywhere (SQLite allows `WITH … DELETE`, so checking the first
 * word alone is not enough).
 */

const WRITE_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'replace',
  'upsert',
  'create',
  'drop',
  'alter',
  'attach',
  'detach',
  'pragma',
  'vacuum',
  'reindex',
  'analyze',
  'truncate',
  'grant',
  'revoke',
  'merge',
  'copy',
];

export class UnsafeSqlError extends Error {
  override readonly name = 'UnsafeSqlError';
}

function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, '``');
}

/** Throws {@link UnsafeSqlError} unless `sql` is a single read-only query. Returns the trimmed SQL. */
export function assertReadOnlySql(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) throw new UnsafeSqlError('Query is empty.');
  const bare = stripLiteralsAndComments(trimmed).toLowerCase();
  if (bare.includes(';')) throw new UnsafeSqlError('Only one statement per query is allowed.');
  const first = bare.trim().split(/\s+/)[0];
  if (first !== 'select' && first !== 'with') {
    throw new UnsafeSqlError('Only SELECT queries (optionally starting with WITH) are allowed.');
  }
  for (const word of WRITE_KEYWORDS) {
    // `replace(...)` is also a string function; only the statement form is a write.
    const pattern = word === 'replace' ? /\breplace\b(?!\s*\()/ : new RegExp(`\\b${word}\\b`);
    if (pattern.test(bare)) {
      throw new UnsafeSqlError(`Read-only queries cannot contain "${word.toUpperCase()}".`);
    }
  }
  return trimmed;
}
