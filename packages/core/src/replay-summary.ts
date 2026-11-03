/**
 * Turn a session recording into a text transcript an agent can read.
 *
 * Agents can't watch video, but they can read `00:14 Rage-clicked "Pay now"
 * (button) ×4` followed by `00:15 ERROR TypeError…`. This merges two sources:
 *
 * - rrweb events (clicks, inputs, navigation) from the replay, and
 * - Glass events for the same session (pageviews, custom events, errors),
 *
 * resolving click targets to human labels using rrweb's serialized DOM.
 *
 * rrweb numbers DOM nodes per page load, so node 42 on /pricing and node 42 on
 * /signup are different elements. The recording therefore arrives as one event
 * list per page load; each is read against its own DOM, and the results are
 * merged into one timeline.
 */

/** The subset of rrweb's event format we read. See rrweb's `EventType` / `IncrementalSource`. */
export interface RrwebEvent {
  type: number;
  timestamp: number;
  // biome-ignore lint/suspicious/noExplicitAny: rrweb event payloads are heterogeneous
  data?: any;
}

export interface SessionEvent {
  event: string;
  ts_ms: number;
  path?: string;
  title?: string;
  props?: Record<string, unknown>;
}

export interface ReplaySummary {
  text: string;
  stats: {
    durationSeconds: number;
    pages: number;
    clicks: number;
    rageClicks: number;
    inputs: number;
    errors: number;
    customEvents: number;
  };
}

const EventType = { FullSnapshot: 2, IncrementalSnapshot: 3, Meta: 4 } as const;
const Source = { Mutation: 0, MouseInteraction: 2, Input: 5 } as const;
const Interaction = { Click: 2, DblClick: 4 } as const;
const NodeType = { Element: 2, Text: 3 } as const;

/** Elements people click on purpose. A click on an icon or span inside one is reported as a click on it. */
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'option']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'option']);
/** Elements whose text is never visible, so never part of a label. */
const HIDDEN_TAGS = new Set(['script', 'style', 'noscript', 'template']);
/** The page itself. Labelling a click on <body> with the page's text would be misleading. */
const PAGE_TAGS = new Set(['html', 'body']);

/** Clicks on the same element this close together (3 or more) are a rage click. */
const RAGE_GAP_MS = 1500;
/** Gaps longer than this are called out: often the moment someone got stuck. */
const IDLE_GAP_MS = 30_000;

interface SerializedNode {
  id: number;
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  childNodes?: SerializedNode[];
}

const tagOf = (node: SerializedNode) => (node.tagName ?? '').toLowerCase();

function attr(node: SerializedNode, name: string): string {
  const value = node.attributes?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** What an element is, in words: "link" rather than "a", "button" for `<input type="submit">`. */
function kindOf(node: SerializedNode): string {
  const role = attr(node, 'role');
  if (INTERACTIVE_ROLES.has(role)) return role;
  const tag = tagOf(node);
  const type = attr(node, 'type').toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return type;
  return tag || 'element';
}

const isInteractive = (node: SerializedNode) =>
  INTERACTIVE_TAGS.has(tagOf(node)) || INTERACTIVE_ROLES.has(attr(node, 'role')) || 'onclick' in (node.attributes ?? {});

const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const article = (word: string) => (/^[aeiou]/.test(word) ? 'an' : 'a');

/** id → node and child → parent for one page's DOM, from snapshots and mutations: enough to label elements. */
class NodeIndex {
  private nodes = new Map<number, SerializedNode>();
  private parents = new Map<number, number>();

  /** A full snapshot describes the whole DOM, so it replaces everything we knew. */
  reset(): void {
    this.nodes.clear();
    this.parents.clear();
  }

  add(node: SerializedNode, parentId?: number): void {
    this.nodes.set(node.id, node);
    if (parentId !== undefined) this.parents.set(node.id, parentId);
    for (const child of node.childNodes ?? []) this.add(child, node.id);
  }

  /** The visible text inside a node, whitespace collapsed, at most `budget` characters. */
  text(id: number, budget = 80): string {
    const node = this.nodes.get(id);
    if (!node) return '';
    if (node.type === NodeType.Text) return (node.textContent ?? '').trim();
    if (HIDDEN_TAGS.has(tagOf(node))) return '';
    if (tagOf(node) === 'img') return attr(node, 'alt');
    let out = '';
    for (const child of node.childNodes ?? []) {
      if (out.length >= budget) break;
      const t = this.text(child.id, budget - out.length);
      if (t) out += (out ? ' ' : '') + t;
    }
    return out.replace(/\s+/g, ' ').slice(0, budget);
  }

  /** `"Pay now" (button)` from the element's accessible name or text, or `button #pay` from its id. */
  private describe(node: SerializedNode): string | null {
    const name = attr(node, 'aria-label') || attr(node, 'title') || attr(node, 'alt') || attr(node, 'placeholder') || attr(node, 'name');
    const text = name || this.text(node.id, 61);
    if (text) return `"${clip(text)}" (${kindOf(node)})`;
    const id = attr(node, 'id');
    return id ? `${kindOf(node)} #${id}` : null;
  }

  /** A readable label for a click or input target: the control around it if there is one, else the element itself. */
  label(id: number): string {
    const chain: SerializedNode[] = [];
    for (let current: number | undefined = id; current !== undefined && chain.length < 6; current = this.parents.get(current)) {
      const node = this.nodes.get(current);
      if (!node) break;
      if (node.type === NodeType.Element) chain.push(node);
    }
    const control = chain.find(isInteractive);
    if (control) {
      const kind = kindOf(control);
      return this.describe(control) ?? `${article(kind)} ${kind}`;
    }
    for (const node of chain) {
      if (PAGE_TAGS.has(tagOf(node))) break;
      const described = this.describe(node);
      if (described) return described;
    }
    const target = chain[0];
    if (!target) return 'an element';
    return PAGE_TAGS.has(tagOf(target)) ? 'the page background' : `<${tagOf(target)}>`;
  }
}

type Stats = ReplaySummary['stats'];
type Line = { ts: number; line: string };

/**
 * Read one page load: label its inputs and clicks against its own DOM, group
 * repeated clicks, and (when Glass has no pageviews) note the page it opened.
 */
function readPage(recording: readonly RrwebEvent[], notePages: boolean, timeline: Line[], stats: Stats): void {
  const index = new NodeIndex();
  const clicks: { ts: number; id: number; label: string }[] = [];
  let lastInputId: number | null = null;
  let opened = false;

  for (const e of [...recording].sort((a, b) => a.timestamp - b.timestamp)) {
    if (e.type === EventType.FullSnapshot && e.data?.node) {
      index.reset();
      index.add(e.data.node);
    }
    // rrweb also emits Meta before periodic re-snapshots; only the first one is a page being opened.
    if (e.type === EventType.Meta && notePages && !opened && e.data?.href) {
      opened = true;
      stats.pages++;
      timeline.push({ ts: e.timestamp, line: `Opened ${e.data.href}` });
    }
    if (e.type !== EventType.IncrementalSnapshot || !e.data) continue;
    if (e.data.source === Source.Mutation) {
      for (const add of e.data.adds ?? []) if (add?.node) index.add(add.node, add.parentId);
    } else if (e.data.source === Source.MouseInteraction && (e.data.type === Interaction.Click || e.data.type === Interaction.DblClick)) {
      // Label now: the element may be gone (or its id reused) by the end of the page.
      clicks.push({ ts: e.timestamp, id: e.data.id, label: index.label(e.data.id) });
      lastInputId = null;
    } else if (e.data.source === Source.Input) {
      if (e.data.id !== lastInputId) {
        stats.inputs++;
        timeline.push({ ts: e.timestamp, line: `Typed into ${index.label(e.data.id)}` });
      }
      lastInputId = e.data.id;
    }
  }

  for (let i = 0; i < clicks.length; ) {
    const first = clicks[i]!;
    let j = i + 1;
    while (j < clicks.length && clicks[j]!.id === first.id && clicks[j]!.label === first.label && clicks[j]!.ts - clicks[j - 1]!.ts < RAGE_GAP_MS) j++;
    const n = j - i;
    stats.clicks += n;
    if (n >= 3) {
      stats.rageClicks++;
      timeline.push({ ts: first.ts, line: `Rage-clicked ${first.label} ×${n}` });
    } else {
      timeline.push({ ts: first.ts, line: `Clicked ${first.label}${n > 1 ? ` ×${n}` : ''}` });
    }
    i = j;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Summarise a session.
 *
 * @param pages  the rrweb recording, one event list per page load (see `loadReplayPages` in the Worker)
 * @param events Glass events from the same session
 */
export function summariseReplay(
  pages: readonly (readonly RrwebEvent[])[],
  events: readonly SessionEvent[] = [],
  meta: { sessionId?: string; person?: string; device?: string } = {},
): ReplaySummary {
  const timeline: Line[] = [];
  const stats: Stats = { durationSeconds: 0, pages: 0, clicks: 0, rageClicks: 0, inputs: 0, errors: 0, customEvents: 0 };
  const hasPageviews = events.some((e) => e.event === '$pageview');

  // A loop, not Math.min(...times): long recordings have more events than a call can take arguments.
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  const see = (ts: number) => {
    if (ts < start) start = ts;
    if (ts > end) end = ts;
  };
  for (const page of pages) for (const e of page) see(e.timestamp);
  for (const e of events) see(e.ts_ms);
  if (start > end) start = end = 0;

  for (const page of pages) readPage(page, !hasPageviews, timeline, stats);

  for (const e of events) {
    if (e.event === '$pageview') {
      stats.pages++;
      timeline.push({ ts: e.ts_ms, line: `Viewed ${e.path || '/'}${e.title ? ` — "${e.title}"` : ''}` });
    } else if (e.event === '$exception') {
      stats.errors++;
      const p = e.props ?? {};
      timeline.push({ ts: e.ts_ms, line: `ERROR ${String(p.type ?? 'Error')}: ${String(p.message ?? '').slice(0, 200)}` });
    } else if (!e.event.startsWith('$')) {
      stats.customEvents++;
      const props = Object.entries(e.props ?? {})
        .filter(([k]) => !k.startsWith('$'))
        .slice(0, 5)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      timeline.push({ ts: e.ts_ms, line: `Event ${e.event}${props ? ` (${props})` : ''}` });
    }
  }

  timeline.sort((a, b) => a.ts - b.ts);
  const lines: string[] = [];
  let previous = start;
  for (const item of timeline) {
    if (item.ts - previous > IDLE_GAP_MS) lines.push(`${clock(previous - start)} …no activity for ${Math.round((item.ts - previous) / 1000)}s`);
    lines.push(`${clock(item.ts - start)} ${item.line}`);
    previous = item.ts;
  }

  stats.durationSeconds = Math.round((end - start) / 1000);
  const header = [
    `Session ${meta.sessionId ?? ''}`.trim(),
    meta.person ? `Person: ${meta.person}` : null,
    meta.device ? `Device: ${meta.device}` : null,
    `Duration ${clock(end - start)}, ${plural(stats.pages, 'page')}, ${plural(stats.clicks, 'click')} (${stats.rageClicks} rage), ${plural(stats.inputs, 'input')}, ${plural(stats.errors, 'error')}`,
  ].filter(Boolean);

  return { text: [...header, '', ...(lines.length ? lines : ['(no interactions recorded)'])].join('\n'), stats };
}
