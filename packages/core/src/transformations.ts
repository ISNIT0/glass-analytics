/**
 * Transformations: rules applied to every event at ingest, before it is stored
 * or sent to destinations. They keep personal data out (hash or redact it), drop
 * noise, and tidy properties — so a mistake in tracking code can be fixed
 * without a deploy, and nothing sensitive reaches the store at all.
 *
 * Each rule can be limited to some events and to events matching filters (query
 * semantics: `plan` is an event property, `person.plan` a person property).
 */

import { z } from 'zod/v4';
import type { StoredEvent } from './events.ts';
import { type EventLike, type Filter, matchEventFilter } from './filters.ts';
import { filterSchema } from './insights/schemas.ts';

const scope = {
  events: z.array(z.string()).optional().describe('Only these events. Default: all.'),
  filters: z.array(filterSchema).optional().describe('Only events matching all of these.'),
  name: z.string().optional(),
};

const propertyList = z
  .array(z.string())
  .min(1)
  .describe(
    'Property names ("email", "person.email", "address.street") or /regex/ patterns of names.',
  );

export const transformationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('drop_event'), ...scope }).describe('Drop matching events entirely.'),
  z.object({ kind: z.literal('drop_properties'), ...scope, properties: propertyList }),
  z.object({
    kind: z.literal('rename_property'),
    ...scope,
    from: z.string().min(1),
    to: z.string().min(1),
  }),
  z.object({
    kind: z.literal('set_property'),
    ...scope,
    property: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({
    kind: z.literal('hash_properties'),
    ...scope,
    properties: propertyList,
  }),
  z.object({
    kind: z.literal('redact'),
    ...scope,
    patterns: z
      .array(z.enum(['email', 'phone', 'credit_card', 'ip']))
      .optional()
      .describe('Built-in patterns to replace with "[redacted]". Default email and phone.'),
    custom: z.array(z.string()).optional().describe('More regular expressions to redact.'),
    fields: z
      .array(z.enum(['props', 'url', 'title', 'referrer']))
      .optional()
      .describe('Where to look. Default all.'),
  }),
]);

export type Transformation = z.infer<typeof transformationSchema>;

const PATTERNS: Record<string, RegExp> = {
  email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  phone: /\+?\d[\d\s().-]{7,}\d/g,
  credit_card: /\b(?:\d[ -]?){12,18}\d\b/g,
  ip: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
};

interface Parsed extends EventLike {
  row: StoredEvent;
}

function parse(row: StoredEvent): Parsed {
  const json = (s: string) => {
    try {
      return JSON.parse(s || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  return {
    ...(row as unknown as Record<string, unknown>),
    row,
    props: json(row.props),
    person: json(row.person_props),
    flags: json(row.flags) as Record<string, string>,
  };
}

function serialise(p: Parsed): StoredEvent {
  return {
    ...p.row,
    url: String(p.url ?? ''),
    title: String(p.title ?? ''),
    referrer: String(p.referrer ?? ''),
    props: JSON.stringify(p.props),
    person_props: JSON.stringify(p.person),
  };
}

function applies(t: Transformation, p: Parsed): boolean {
  if (t.events?.length && !t.events.includes(String(p.event))) return false;
  return (t.filters ?? []).every((f) => matchEventFilter(f as Filter, p));
}

/** Resolve a property name to the object holding it and the key: props by default, person.* for people. */
function locate(p: Parsed, name: string): { obj: Record<string, unknown>; key: string } | null {
  const [root, path] = name.startsWith('person.')
    ? [p.person, name.slice(7)]
    : [p.props, name.replace(/^props\./, '')];
  const parts = path.split('.');
  let obj: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (!obj || typeof obj !== 'object') return null;
    obj = (obj as Record<string, unknown>)[part];
  }
  if (!obj || typeof obj !== 'object') return null;
  return { obj: obj as Record<string, unknown>, key: parts.at(-1)! };
}

/** Top-level names matching a /regex/ entry, or the entry itself. */
function names(p: Parsed, list: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of list) {
    const m = /^\/(.+)\/([a-z]*)$/.exec(entry);
    if (!m) {
      out.push(entry);
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(m[1]!, m[2]);
    } catch {
      continue;
    }
    for (const k of Object.keys(p.props)) if (re.test(k)) out.push(k);
    for (const k of Object.keys(p.person)) if (re.test(k)) out.push(`person.${k}`);
  }
  return out;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function redactValue(value: unknown, patterns: RegExp[]): unknown {
  if (typeof value === 'string') {
    let s = value;
    for (const re of patterns) s = s.replace(re, '[redacted]');
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, patterns));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, patterns)]));
  }
  return value;
}

/**
 * Apply rules in order. Returns the rows to keep (dropped events are gone) and how many
 * each rule changed or dropped. `salt` keys hashing (a per-deployment secret), so hashed
 * values can be joined across events but not reversed by guessing.
 */
export async function applyTransformations(
  rows: StoredEvent[],
  rules: readonly Transformation[],
  salt: string,
): Promise<{ rows: StoredEvent[]; counts: number[] }> {
  const counts = rules.map(() => 0);
  if (rules.length === 0) return { rows, counts };
  const out: StoredEvent[] = [];
  for (const row of rows) {
    const p = parse(row);
    let dropped = false;
    for (let i = 0; i < rules.length && !dropped; i++) {
      const t = rules[i]!;
      if (!applies(t, p)) continue;
      switch (t.kind) {
        case 'drop_event':
          dropped = true;
          counts[i]!++;
          break;
        case 'drop_properties':
          for (const name of names(p, t.properties)) {
            const at = locate(p, name);
            if (at && at.key in at.obj) {
              delete at.obj[at.key];
              counts[i]!++;
            }
          }
          break;
        case 'rename_property': {
          const from = locate(p, t.from);
          const to = locate(p, t.to);
          if (from && to && from.key in from.obj) {
            to.obj[to.key] = from.obj[from.key];
            delete from.obj[from.key];
            counts[i]!++;
          }
          break;
        }
        case 'set_property': {
          const at = locate(p, t.property);
          if (at) {
            at.obj[at.key] = t.value;
            counts[i]!++;
          }
          break;
        }
        case 'hash_properties':
          for (const name of names(p, t.properties)) {
            const at = locate(p, name);
            const v = at?.obj[at.key];
            if (at && v !== undefined && v !== null && v !== '') {
              at.obj[at.key] = await sha256(
                `${salt}:${typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
              );
              counts[i]!++;
            }
          }
          break;
        case 'redact': {
          const patterns = [
            ...(t.patterns ?? ['email', 'phone']).map(
              (k) => new RegExp(PATTERNS[k]!.source, PATTERNS[k]!.flags),
            ),
            ...(t.custom ?? []).flatMap((c) => {
              try {
                return [new RegExp(c, 'g')];
              } catch {
                return [];
              }
            }),
          ];
          const fields = t.fields ?? ['props', 'url', 'title', 'referrer'];
          const before = JSON.stringify([p.props, p.url, p.title, p.referrer]);
          if (fields.includes('props'))
            p.props = redactValue(p.props, patterns) as Record<string, unknown>;
          for (const f of ['url', 'title', 'referrer'] as const) {
            if (fields.includes(f)) p[f] = redactValue(p[f], patterns);
          }
          if (JSON.stringify([p.props, p.url, p.title, p.referrer]) !== before) counts[i]!++;
          break;
        }
      }
    }
    if (!dropped) out.push(serialise(p));
  }
  return { rows: out, counts };
}
