/**
 * Turn a session recording into a timeline, and that timeline into a text
 * transcript an agent can read.
 *
 * Agents can't watch video, but they can read `00:14 Rage-clicked "Pay now"
 * (button) ×4 · #pay` followed by `00:15 ERROR TypeError…`. This merges:
 *
 * - rrweb events (clicks, inputs, navigation) from the replay,
 * - console messages and network requests the recorder adds as custom events,
 * - Glass events for the same session (pageviews, custom events, errors), and
 * - notes people and agents left on the session,
 *
 * resolving click targets to human labels and selectors with a DOM model
 * (`replay-dom.ts`). The dashboard's activity panel and timeline markers come
 * from the same structured timeline, so humans and agents see the same story.
 *
 * rrweb numbers DOM nodes per page load, so node 42 on /pricing and node 42 on
 * /signup are different elements. The recording therefore arrives as one event
 * list per page load; each is read against its own DOM.
 */

import { DomModel, EventType, type RrwebEvent, Source } from './replay-dom.ts';

export type { RrwebEvent } from './replay-dom.ts';

export interface SessionEvent {
  event: string;
  ts_ms: number;
  path?: string;
  url?: string;
  title?: string;
  props?: Record<string, unknown>;
}

export interface ReplayNote {
  id?: string;
  ts: number;
  text: string;
  author?: string;
}

export type TimelineKind =
  | 'page'
  | 'click'
  | 'input'
  | 'event'
  | 'error'
  | 'console'
  | 'network'
  | 'idle'
  | 'note';

export interface TimelineItem {
  /** Epoch ms. */
  ts: number;
  /** Ms since the start of the session. */
  t: number;
  kind: TimelineKind;
  /** One line, as it appears in the transcript (without the time). */
  text: string;
  /** Clicks and inputs: the element, e.g. `"Pay now" (button)`. */
  label?: string;
  /** Clicks and inputs: a CSS selector likely to appear in the source code. */
  selector?: string;
  /** Pages: the URL or path. Network: the request URL. */
  url?: string;
  /** Repeated clicks or events folded into one item. */
  count?: number;
  /** Clicks: epoch ms of the last click of a burst. */
  end?: number;
  /** Errors: the first stack frames. Console: the full message. Network: method, status and timing. */
  detail?: string;
  /** `error` and `warn` items are highlighted on the timeline. */
  level?: 'error' | 'warn' | 'info';
  /** Frustration signals: rage (3+ quick clicks), dead (nothing changed), error (an error followed). */
  signals?: ('rage' | 'dead' | 'error')[];
  /** Notes: who wrote it, and its id for deletion. */
  author?: string;
  id?: string;
  /** Hidden from the default transcript (routine console logs and successful requests). */
  verbose?: boolean;
}

export interface ReplayStats {
  durationSeconds: number;
  activeSeconds: number;
  pages: number;
  clicks: number;
  rageClicks: number;
  deadClicks: number;
  errorClicks: number;
  inputs: number;
  errors: number;
  consoleErrors: number;
  failedRequests: number;
  customEvents: number;
}

export interface ReplaySummary {
  text: string;
  stats: ReplayStats;
  timeline: TimelineItem[];
  startedAt: number;
  endedAt: number;
}

/** Clicks on the same element this close together (3 or more) are a rage click. */
const RAGE_GAP_MS = 1500;
/** A click on a control after which nothing on the page changes for this long is a dead click. */
const DEAD_CLICK_MS = 1000;
/** An error this soon after a click is attributed to it. */
const ERROR_CLICK_MS = 1000;
/** Gaps longer than this are called out: often the moment someone got stuck. */
const IDLE_GAP_MS = 30_000;
/** Activity counts towards active time for at most this long after each input. */
const ACTIVE_SLICE_MS = 5000;
/** Requests slower than this are reported even when they succeed. */
const SLOW_REQUEST_MS = 3000;
/** Repeats of the same custom event this close together are folded into one line. */
const REPEAT_GAP_MS = 2000;

const USER_SOURCES: Set<number> = new Set([
  Source.MouseMove,
  Source.MouseInteraction,
  Source.Scroll,
  Source.Input,
  Source.TouchMove,
]);
/** Things that show the page responded to a click. */
const RESPONSE_SOURCES: Set<number> = new Set([Source.Mutation, Source.Scroll, Source.Input]);
const Interaction = { Click: 2, DblClick: 4 } as const;
/** Clicks on these don't change the DOM when they work (focus, native pickers), so they are never dead. */
const NEVER_DEAD = new Set(['input', 'select', 'textarea', 'label', 'option']);

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** "00:14", "14", "1:02:03" or a number of ms → ms since session start. */
export function parseOffset(input: string | number): number {
  if (typeof input === 'number') return Math.max(0, input);
  const parts = input.trim().split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p)))
    throw new Error(`Can't read "${input}" as a time. Use mm:ss, e.g. "01:24".`);
  return Math.max(0, parts.reduce((acc, p) => acc * 60 + p, 0) * 1000);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

/** The first few frames of a stack, without the message line. */
export function stackFrames(stack: unknown, max = 3): string[] {
  if (typeof stack !== 'string') return [];
  return stack
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^at\s|@/.test(l))
    .slice(0, max);
}

/** URLs without query strings (they hold tokens and ids more often than they help). */
const bareUrl = (url: string) => {
  try {
    const u = new URL(url, 'https://x.invalid');
    return u.origin === 'https://x.invalid' ? u.pathname : `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
};

interface PageRead {
  items: Omit<TimelineItem, 't'>[];
  /** Timestamps where the user did something, for active time. */
  activity: number[];
}

/** Read one page load: label its inputs and clicks against its own DOM, and pick up console and network events. */
function readPage(
  recording: readonly RrwebEvent[],
  notePages: boolean,
  stats: ReplayStats,
): PageRead {
  const dom = new DomModel();
  const items: Omit<TimelineItem, 't'>[] = [];
  const activity: number[] = [];
  const responses: number[] = [];
  const clicks: { ts: number; target: ReturnType<DomModel['target']> }[] = [];
  let lastInputId: number | null = null;
  let opened = false;
  let lastUrl = '';
  const events = [...recording].sort((a, b) => a.timestamp - b.timestamp);
  const pageEnd = events.at(-1)?.timestamp ?? 0;

  for (const e of events) {
    if (e.type === EventType.FullSnapshot && e.data?.node) {
      dom.reset(e.data.node);
      responses.push(e.timestamp);
    }
    // rrweb also emits Meta before periodic re-snapshots; only the first one is a page being opened.
    if (e.type === EventType.Meta && e.data?.href) {
      responses.push(e.timestamp);
      if (!opened) {
        opened = true;
        lastUrl = e.data.href;
        if (notePages) {
          stats.pages++;
          items.push({
            ts: e.timestamp,
            kind: 'page',
            text: `Opened ${bareUrl(e.data.href)}`,
            url: e.data.href,
          });
        }
      }
    }
    if (e.type === EventType.Custom) {
      const tag = e.data?.tag;
      const p = e.data?.payload ?? {};
      if (tag === 'glass:url' && typeof p.href === 'string' && p.href !== lastUrl) {
        lastUrl = p.href;
        responses.push(e.timestamp);
        if (notePages) {
          stats.pages++;
          items.push({
            ts: e.timestamp,
            kind: 'page',
            text: `Navigated to ${bareUrl(p.href)}`,
            url: p.href,
          });
        }
      } else if (tag === 'glass:console') {
        const level = p.level === 'error' ? 'error' : p.level === 'warn' ? 'warn' : 'info';
        const message = String(p.message ?? '').replace(/\s+/g, ' ');
        if (level === 'error') stats.consoleErrors++;
        items.push({
          ts: e.timestamp,
          kind: 'console',
          level,
          text: `Console ${p.level ?? 'log'}: ${message.slice(0, 200)}`,
          detail: [String(p.message ?? ''), ...stackFrames(p.stack, 5)].join('\n').slice(0, 2000),
          verbose: level === 'info',
        });
      } else if (tag === 'glass:network') {
        const status = Number(p.status) || 0;
        const duration = Number(p.duration) || 0;
        const failed = status === 0 || status >= 400;
        const slow = duration >= SLOW_REQUEST_MS;
        if (failed) stats.failedRequests++;
        const what = `${String(p.method ?? 'GET').toUpperCase()} ${bareUrl(String(p.url ?? ''))}`;
        const outcome = status ? String(status) : String(p.error ?? 'network error');
        items.push({
          ts: e.timestamp,
          kind: 'network',
          level: failed ? 'error' : slow ? 'warn' : 'info',
          text: `${failed ? 'Request failed' : slow ? 'Slow request' : 'Request'}: ${what} → ${outcome} (${ms(duration)})`,
          url: String(p.url ?? ''),
          detail: `${what}\nStatus: ${outcome}\nDuration: ${ms(duration)}${p.size ? `\nResponse size: ${p.size} bytes` : ''}`,
          verbose: !failed && !slow,
        });
      }
    }
    if (e.type !== EventType.IncrementalSnapshot || !e.data) continue;
    const source = e.data.source;
    if (USER_SOURCES.has(source)) activity.push(e.timestamp);
    if (RESPONSE_SOURCES.has(source)) responses.push(e.timestamp);
    if (source === Source.Mutation) {
      dom.mutate(e.data);
    } else if (
      source === Source.MouseInteraction &&
      (e.data.type === Interaction.Click || e.data.type === Interaction.DblClick)
    ) {
      // Resolve now: the element may be gone (or changed) by the end of the page.
      clicks.push({ ts: e.timestamp, target: dom.target(e.data.id) });
      lastInputId = null;
    } else if (source === Source.Input) {
      dom.input(e.data);
      if (e.data.id !== lastInputId) {
        stats.inputs++;
        const target = dom.target(e.data.id);
        items.push({
          ts: e.timestamp,
          kind: 'input',
          text: `Typed into ${target.label}`,
          label: target.label,
          selector: target.selector || undefined,
        });
      }
      lastInputId = e.data.id;
    }
  }

  // `responses` is in time order, so a binary search finds the first one after a click.
  const respondedWithin = (ts: number, window: number) => {
    let lo = 0;
    let hi = responses.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (responses[mid]! <= ts) lo = mid + 1;
      else hi = mid;
    }
    return lo < responses.length && responses[lo]! <= ts + window;
  };

  for (let i = 0; i < clicks.length; ) {
    const first = clicks[i]!;
    let j = i + 1;
    while (
      j < clicks.length &&
      clicks[j]!.target.id === first.target.id &&
      clicks[j]!.target.label === first.target.label &&
      clicks[j]!.ts - clicks[j - 1]!.ts < RAGE_GAP_MS
    )
      j++;
    const n = j - i;
    const last = clicks[j - 1]!;
    stats.clicks += n;
    const signals: TimelineItem['signals'] = [];
    if (n >= 3) {
      stats.rageClicks++;
      signals.push('rage');
    }
    const control = first.target.control;
    const tag = (control?.tagName ?? '').toLowerCase();
    // A click near the end of a page load probably navigated; a link to a new tab changes nothing here.
    const deadCandidate =
      control &&
      !NEVER_DEAD.has(tag) &&
      control.attributes?.target !== '_blank' &&
      pageEnd - last.ts > DEAD_CLICK_MS;
    if (deadCandidate && !respondedWithin(first.ts, DEAD_CLICK_MS)) {
      stats.deadClicks++;
      signals.push('dead');
    }
    const verb = signals.includes('rage') ? 'Rage-clicked' : 'Clicked';
    items.push({
      ts: first.ts,
      kind: 'click',
      text: `${verb} ${first.target.label}${n > 1 ? ` ×${n}` : ''}`,
      label: first.target.label,
      selector: first.target.selector || undefined,
      count: n > 1 ? n : undefined,
      end: n > 1 ? last.ts : undefined,
      signals: signals.length ? signals : undefined,
      level: signals.length ? 'warn' : undefined,
    });
    i = j;
  }
  return { items, activity };
}

/** Sum of activity, counting each burst of input for at most ACTIVE_SLICE_MS. */
function activeMs(times: number[]): number {
  times.sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i < times.length; i++) {
    const next = times[i + 1];
    total += next === undefined ? 0 : Math.min(next - times[i]!, ACTIVE_SLICE_MS);
  }
  return total;
}

export interface SummariseOptions {
  sessionId?: string;
  person?: string;
  device?: string;
  notes?: readonly ReplayNote[];
  /** "full" also lists every console message and network request. Default "normal". */
  detail?: 'normal' | 'full';
}

/**
 * Summarise a session.
 *
 * @param pages  the rrweb recording, one event list per page load (see `loadReplayPages` in the Worker)
 * @param events Glass events from the same session
 */
export function summariseReplay(
  pages: readonly (readonly RrwebEvent[])[],
  events: readonly SessionEvent[] = [],
  meta: SummariseOptions = {},
): ReplaySummary {
  const stats: ReplayStats = {
    durationSeconds: 0,
    activeSeconds: 0,
    pages: 0,
    clicks: 0,
    rageClicks: 0,
    deadClicks: 0,
    errorClicks: 0,
    inputs: 0,
    errors: 0,
    consoleErrors: 0,
    failedRequests: 0,
    customEvents: 0,
  };
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

  const raw: Omit<TimelineItem, 't'>[] = [];
  const activity: number[] = [];
  for (const page of pages) {
    const read = readPage(page, !hasPageviews, stats);
    for (const item of read.items) raw.push(item);
    for (const ts of read.activity) activity.push(ts);
  }

  let previousEvent: Omit<TimelineItem, 't'> | null = null;
  let previousText = '';
  let previousTs = 0;
  for (const e of [...events].sort((a, b) => a.ts_ms - b.ts_ms)) {
    if (e.event === '$pageview') {
      stats.pages++;
      raw.push({
        ts: e.ts_ms,
        kind: 'page',
        text: `Viewed ${e.path || '/'}${e.title ? ` — "${e.title}"` : ''}`,
        url: e.url || e.path || '/',
      });
    } else if (e.event === '$exception') {
      stats.errors++;
      const p = e.props ?? {};
      const frames = stackFrames(p.stack);
      raw.push({
        ts: e.ts_ms,
        kind: 'error',
        level: 'error',
        text: `ERROR ${String(p.type ?? 'Error')}: ${String(p.message ?? '').slice(0, 200)}`,
        detail: [
          String(p.message ?? ''),
          ...(frames.length
            ? frames
            : p.source
              ? [`at ${p.source}:${p.line ?? '?'}:${p.column ?? '?'}`]
              : []),
        ].join('\n'),
      });
    } else if (!e.event.startsWith('$')) {
      stats.customEvents++;
      const props = Object.entries(e.props ?? {})
        .filter(([k]) => !k.startsWith('$'))
        .slice(0, 5)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      const text = `Event ${e.event}${props ? ` (${props})` : ''}`;
      // Fold quick repeats of the identical event (a button handler firing on every rage click).
      if (previousEvent && previousText === text && e.ts_ms - previousTs < REPEAT_GAP_MS) {
        previousEvent.count = (previousEvent.count ?? 1) + 1;
        previousEvent.text = `${text} ×${previousEvent.count}`;
        previousTs = e.ts_ms;
        continue;
      }
      previousEvent = { ts: e.ts_ms, kind: 'event', text };
      previousText = text;
      previousTs = e.ts_ms;
      raw.push(previousEvent);
    }
  }

  raw.sort((a, b) => a.ts - b.ts || order(a.kind) - order(b.kind));

  // Error clicks: an exception or console error soon after a click (or the last click of a burst),
  // on the same page: an error after a click that navigated belongs to the next page.
  for (const [i, item] of raw.entries()) {
    if (item.kind !== 'click') continue;
    const until = (item.end ?? item.ts) + ERROR_CLICK_MS;
    for (let j = i + 1; j < raw.length && raw[j]!.ts <= until; j++) {
      const next = raw[j]!;
      if (next.kind === 'page') break;
      if (next.kind === 'error' || (next.kind === 'console' && next.level === 'error')) {
        stats.errorClicks++;
        item.signals = [...(item.signals ?? []), 'error'];
        item.level = 'error';
        break;
      }
    }
  }
  const timeline: TimelineItem[] = [];
  let previous = start;
  for (const item of raw) {
    if (item.kind !== 'note' && item.ts - previous > IDLE_GAP_MS) {
      timeline.push({
        ts: previous,
        t: previous - start,
        kind: 'idle',
        text: `…no activity for ${Math.round((item.ts - previous) / 1000)}s`,
      });
    }
    timeline.push({ ...item, t: Math.max(0, item.ts - start) });
    if (item.kind !== 'note') previous = Math.max(previous, item.ts);
  }

  stats.durationSeconds = Math.round((end - start) / 1000);
  stats.activeSeconds = Math.round(activeMs(activity) / 1000);
  return renderSummary({ stats, timeline, startedAt: start, endedAt: end }, meta);
}

/**
 * Add notes to a summary's timeline and write its transcript. Cached summaries
 * are stored without notes or text, and finished here on every read.
 */
export function renderSummary(
  base: Omit<ReplaySummary, 'text'>,
  meta: SummariseOptions = {},
): ReplaySummary {
  let timeline = base.timeline.filter((i) => i.kind !== 'note');
  if (meta.notes?.length) {
    const notes: TimelineItem[] = meta.notes.map((n) => ({
      ts: n.ts,
      t: Math.max(0, n.ts - base.startedAt),
      kind: 'note',
      text: `Note${n.author ? ` (${n.author})` : ''}: ${n.text}`,
      author: n.author,
      id: n.id,
    }));
    timeline = [...timeline, ...notes].sort((a, b) => a.t - b.t || order(a.kind) - order(b.kind));
  }
  return { ...base, timeline, text: transcript(timeline, base.stats, meta) };
}

/** Pages first, then what happened on them; errors after the click that caused them. */
function order(kind: TimelineKind): number {
  return ['page', 'input', 'click', 'event', 'network', 'console', 'error', 'note', 'idle'].indexOf(
    kind,
  );
}

function transcript(
  timeline: readonly TimelineItem[],
  stats: ReplayStats,
  meta: SummariseOptions,
): string {
  const frustration = [
    stats.rageClicks ? `${stats.rageClicks} rage` : '',
    stats.deadClicks ? `${stats.deadClicks} dead` : '',
    stats.errorClicks ? `${stats.errorClicks} followed by an error` : '',
  ].filter(Boolean);
  const problems = [
    plural(stats.errors, 'error'),
    stats.consoleErrors ? plural(stats.consoleErrors, 'console error') : '',
    stats.failedRequests ? plural(stats.failedRequests, 'failed request') : '',
  ].filter(Boolean);
  const header = [
    `Session ${meta.sessionId ?? ''}`.trim(),
    meta.person ? `Person: ${meta.person}` : null,
    meta.device ? `Device: ${meta.device}` : null,
    `Duration ${clock(stats.durationSeconds * 1000)} (${clock(stats.activeSeconds * 1000)} active), ${plural(stats.pages, 'page')}, ${plural(stats.clicks, 'click')}${frustration.length ? ` (${frustration.join(', ')})` : ''}, ${plural(stats.inputs, 'input')}, ${problems.join(', ')}`,
  ].filter(Boolean);

  const lines: string[] = [];
  for (const item of timeline) {
    if (item.verbose && meta.detail !== 'full') continue;
    let line = `${clock(item.t)} ${item.text}`;
    if (item.selector) line += ` · ${item.selector}`;
    const flags = (item.signals ?? []).filter((s) => s !== 'rage');
    if (flags.length)
      line += ` [${flags.map((s) => (s === 'dead' ? 'dead click: nothing changed' : 'an error followed')).join('; ')}]`;
    lines.push(line);
    if (item.kind === 'error' && item.detail) {
      for (const frame of item.detail.split('\n').slice(1)) lines.push(`      ${frame}`);
    }
  }
  return [...header, '', ...(lines.length ? lines : ['(no interactions recorded)'])].join('\n');
}

/**
 * What was on screen at one moment (`ts`, epoch ms): the URL, viewport, scroll
 * position and the page's content as readable text.
 */
export function snapshotAt(
  pages: readonly (readonly RrwebEvent[])[],
  ts: number,
): { url: string; viewport: string; scrollY: number; text: string } {
  // The page load showing at `ts`: the latest one that had started by then.
  const ordered = [...pages]
    .filter((p) => p.length)
    .map((p) => [...p].sort((a, b) => a.timestamp - b.timestamp))
    .sort((a, b) => a[0]!.timestamp - b[0]!.timestamp);
  if (!ordered.length) return { url: '', viewport: '', scrollY: 0, text: '(empty recording)' };
  const page = [...ordered].reverse().find((p) => p[0]!.timestamp <= ts) ?? ordered[0]!;
  const dom = new DomModel();
  let url = '';
  let viewport = '';
  let scrollY = 0;
  let rootId = 1;
  // Before the page's first snapshot (the transcript can start with a pageview the recorder hadn't seen yet), show that snapshot.
  const firstFrame = page.find((e) => e.type === EventType.FullSnapshot)?.timestamp ?? ts;
  const until = Math.max(ts, firstFrame);
  for (const e of page) {
    if (e.timestamp > until) break;
    if (e.type === EventType.Meta) {
      url = e.data?.href ?? url;
      if (e.data?.width) viewport = `${e.data.width}×${e.data.height}`;
    } else if (e.type === EventType.FullSnapshot && e.data?.node) {
      dom.reset(e.data.node);
      rootId = e.data.node.id;
    } else if (e.type === EventType.Custom && e.data?.tag === 'glass:url') {
      url = e.data.payload?.href ?? url;
    } else if (e.type === EventType.IncrementalSnapshot && e.data) {
      if (e.data.source === Source.Mutation) dom.mutate(e.data);
      else if (e.data.source === Source.Input) dom.input(e.data);
      else if (e.data.source === Source.ViewportResize)
        viewport = `${e.data.width}×${e.data.height}`;
      else if (
        e.data.source === Source.Scroll &&
        (e.data.id === rootId || dom.get(e.data.id)?.tagName === 'html')
      )
        scrollY = Math.round(e.data.y ?? 0);
    }
  }
  return { url, viewport, scrollY, text: dom.render() || '(nothing visible)' };
}
