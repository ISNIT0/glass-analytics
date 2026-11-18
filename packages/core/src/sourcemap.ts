/**
 * Source maps (revision 3): mapping a minified frame back to the original file,
 * line, column and function name, with a few lines of the original code around it
 * when the map carries `sourcesContent`. A small Base64 VLQ decoder, no dependencies.
 *
 * Only the generated lines up to the one asked for are decoded (minified bundles
 * are often one line, so that is usually all of them), and nothing is kept per
 * segment beyond the line being searched.
 */

export interface RawSourceMap {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: (string | null)[];
  sourcesContent?: (string | null)[];
  names?: string[];
  mappings: string;
  sections?: unknown[];
}

export interface OriginalPosition {
  source: string;
  /** 1-based. */
  line: number;
  /** 1-based, like the browser's columns. */
  column: number;
  name: string | null;
  /** Lines around the position, when the map has the source. */
  context?: { pre: string[]; line: string; post: string[] };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) DIGIT[B64.charCodeAt(i)] = i;

/** Decode one segment's VLQ values starting at `pos`; returns the values and where it stopped. */
export function decodeVlq(mappings: string, pos: number, out: number[]): number {
  out.length = 0;
  let value = 0;
  let shift = 0;
  while (pos < mappings.length) {
    const ch = mappings.charCodeAt(pos);
    if (ch === 44 /* , */ || ch === 59 /* ; */) break;
    const digit = ch < 128 ? DIGIT[ch]! : -1;
    if (digit < 0) throw new Error(`Invalid source map mappings at ${pos}`);
    pos++;
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    out.push(value % 2 === 1 ? -Math.floor(value / 2) : Math.floor(value / 2));
    value = 0;
    shift = 0;
  }
  return pos;
}

/** Parse and check a map: version 3, with mappings (index maps with `sections` aren't supported). */
export function parseSourceMap(text: string): RawSourceMap {
  const map = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/, '')) as RawSourceMap;
  if (!map || typeof map !== 'object') throw new Error('Not a source map');
  if (map.sections)
    throw new Error(
      'Index source maps (with "sections") are not supported; upload one map per file',
    );
  if (map.version !== 3 || typeof map.mappings !== 'string' || !Array.isArray(map.sources)) {
    throw new Error('Not a version 3 source map with "mappings" and "sources"');
  }
  return map;
}

/**
 * The original position for a generated 1-based line and column. Returns null when that spot has
 * no mapping (generated code with no source, or a line past the end).
 */
export function originalPositionFor(
  map: RawSourceMap,
  line: number,
  column: number,
  contextLines = 3,
): OriginalPosition | null {
  const targetLine = line - 1;
  const targetCol = Math.max(0, column - 1);
  const m = map.mappings;
  let pos = 0;
  let genLine = 0;
  // Cumulative state across the whole file (only the generated column resets per line).
  let src = 0;
  let srcLine = 0;
  let srcCol = 0;
  let name = 0;
  const seg: number[] = [];
  let best: { src: number; line: number; col: number; name: number | null } | null = null;
  while (pos < m.length && genLine <= targetLine) {
    let genCol = 0;
    // One generated line.
    while (pos < m.length && m.charCodeAt(pos) !== 59) {
      if (m.charCodeAt(pos) === 44) {
        pos++;
        continue;
      }
      pos = decodeVlq(m, pos, seg);
      if (seg.length === 0) continue;
      genCol += seg[0]!;
      let hasSource = false;
      let hasName = false;
      if (seg.length >= 4) {
        src += seg[1]!;
        srcLine += seg[2]!;
        srcCol += seg[3]!;
        hasSource = true;
      }
      if (seg.length >= 5) {
        name += seg[4]!;
        hasName = true;
      }
      if (genLine === targetLine && genCol <= targetCol) {
        best = hasSource ? { src, line: srcLine, col: srcCol, name: hasName ? name : null } : null;
      }
    }
    if (genLine === targetLine) break;
    pos++; // the ";"
    genLine++;
  }
  if (!best) return null;
  const root = map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') : '';
  const source = `${root}${map.sources[best.src] ?? ''}`;
  const out: OriginalPosition = {
    source,
    line: best.line + 1,
    column: best.col + 1,
    name: best.name === null ? null : (map.names?.[best.name] ?? null),
  };
  const content = map.sourcesContent?.[best.src];
  if (typeof content === 'string') {
    const lines = content.split(/\r?\n/);
    const i = best.line;
    out.context = {
      pre: lines.slice(Math.max(0, i - contextLines), i).map((l) => l.slice(0, 300)),
      line: (lines[i] ?? '').slice(0, 300),
      post: lines.slice(i + 1, i + 1 + contextLines).map((l) => l.slice(0, 300)),
    };
  }
  return out;
}
