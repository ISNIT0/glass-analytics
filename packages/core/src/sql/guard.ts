/**
 * A guard for user-supplied SQL (the `sql` tool and `dataflare sql`).
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

/**
 * Blanks out comments and quoted strings in one left-to-right pass. Doing them
 * in separate passes lets one hide the other: a `/*` or `--` inside a string
 * literal would otherwise be read as a comment that swallows the closing quote
 * and whatever statement follows it.
 */
function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new UnsafeSqlError('Unterminated comment.');
      i = end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      // A doubled quote is an escaped quote inside the literal.
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(c, j);
        if (k === -1) throw new UnsafeSqlError('Unterminated quoted string.');
        if (sql[k + 1] === c) {
          j = k + 2;
          continue;
        }
        i = k + 1;
        break;
      }
      out += c + c;
    } else {
      out += c;
      i++;
    }
  }
  return out;
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
