/**
 * One event as sent to the Worker. Mirrors `WireEvent` in @glassanalytics/core (kept as
 * a copy so the published type declarations are self-contained; a test fails
 * if the two drift apart).
 */
export interface WireEvent {
  id: string;
  event: string;
  ts: number;
  distinct_id?: string | null;
  user_id?: string | null;
  session_id?: string | null;
  url?: string | null;
  referrer?: string | null;
  title?: string | null;
  props?: Record<string, unknown>;
  flags?: Record<string, string>;
}

export type Persistence = 'localStorage' | 'cookieless';

export interface AutocaptureOptions {
  /** `$pageview` on load and on client-side navigation. Default true. */
  pageviews?: boolean;
  /** `$click` on links, buttons and elements with `data-glass-event`. Default true. */
  clicks?: boolean;
  /** `$exception` for uncaught errors and unhandled promise rejections. Default true. */
  errors?: boolean;
  /** `$web_vitals` (LCP, CLS, INP, FCP, TTFB) sent when the page is hidden. Default true. */
  webVitals?: boolean;
}

export interface ReplayOptions {
  /** Share of sessions to record, 0–1. Default 0. */
  sampleRate?: number;
  /**
   * Share of sessions to keep a rolling in-memory buffer for, uploaded only if an
   * error happens. 0–1. Default 0. Costs CPU on every buffered session.
   */
  onErrorSampleRate?: number;
  /** Mask all text, not just inputs. Default false (inputs are always masked). */
  maskAllText?: boolean;
  /** CSS selector of elements to leave out of recordings entirely. Default `[data-glass-block]`. */
  blockSelector?: string;
}

export interface GlassOptions {
  /** Base URL of your Glass Worker, e.g. "https://glass.acme.workers.dev" or "/_glass". */
  host: string;
  /** Project id, e.g. "acme-web". */
  project: string;
  /**
   * "localStorage" (default) keeps an anonymous device id so funnels, retention,
   * experiments and replay work. "cookieless" stores nothing on the device; the
   * Worker derives a daily-rotating id from IP + user agent, which is enough for
   * web analytics but not for product analytics. Call `consent(true)` to upgrade.
   */
  persistence?: Persistence;
  /** `false` disables all autocapture. */
  autocapture?: boolean | AutocaptureOptions;
  /** Session replay. Off unless a sample rate is set. */
  replay?: ReplayOptions | false;
  /** Fetch feature flags on init. Default true. */
  flags?: boolean;
  /** Inspect or rewrite every event before it is queued. Return null to drop it. */
  beforeSend?: (event: WireEvent) => WireEvent | null;
  /** Send at most this often, in ms. Default 5000. */
  flushIntervalMs?: number;
  /** Log every event to the console. */
  debug?: boolean;
}

/** The interface implemented by `replay.js`, loaded on demand from the Worker. */
export interface ReplayModule {
  startReplay(options: ReplayStartOptions): ReplayController;
}

export interface ReplayStartOptions {
  host: string;
  project: string;
  sessionId: string;
  distinctId: string | null;
  userId: string | null;
  /** "record" uploads continuously; "buffer" keeps the last ~60s in memory until `flushBuffer()`. */
  mode: 'record' | 'buffer';
  maskAllText: boolean;
  blockSelector: string;
}

export interface ReplayController {
  /** Stop recording and upload what is pending. */
  stop(): void;
  /** Switch from buffer mode to recording: upload the buffer and keep going. */
  flushBuffer(): void;
  /** Count an error against the current chunk (shown in the replay list). */
  noteError(): void;
}
