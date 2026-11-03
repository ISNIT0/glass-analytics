/**
 * Session replay recorder, built separately as `replay.js` and served by the
 * Worker. The SDK loads it on demand, so rrweb (~70 KB) is only downloaded for
 * sessions that are actually recorded.
 *
 * Uploads go to `POST /r`, gzipped with CompressionStream. They are shaped by
 * one browser limit: a request that must outlive the page (`sendBeacon`, or
 * `fetch` with `keepalive`) can carry about 64 KB, shared with the SDK's own
 * last batch. Real pages' DOM snapshots are usually bigger than that, so:
 *
 * - the full snapshot that starts each page load is uploaded straight away;
 * - after that, events are uploaded once more than a beacon's worth is waiting
 *   (at most once a second), and every 10 seconds regardless;
 * - so when the page is hidden, what's left fits in one `sendBeacon`, which is
 *   sent uncompressed because compression is asynchronous and a page that is
 *   going away can't wait for it.
 *
 * Privacy defaults: every input is masked; `maskAllText` masks all text too;
 * elements matching `blockSelector` are not recorded at all.
 */

import { record } from 'rrweb';
import type { ReplayController, ReplayModule, ReplayStartOptions } from './types.ts';

const CHUNK_MS = 10_000;
/** What one beacon can carry, leaving room for the SDK's own batch (browsers allow 64 KB in flight). */
const BEACON_CHARS = 48_000;
/** Size-triggered uploads happen at most this often, so a busy page can't create thousands of chunks. */
const MIN_UPLOAD_GAP_MS = 1_000;
const BUFFER_CHECKOUT_MS = 30_000;
const FULL_SNAPSHOT = 2;

interface RecordedEvent {
  type: number;
  timestamp: number;
  // biome-ignore lint/suspicious/noExplicitAny: rrweb payloads are heterogeneous
  data?: any;
}

const isClick = (e: RecordedEvent) => e.type === 3 && e.data?.source === 2 && e.data?.type === 2;

function startReplay(options: ReplayStartOptions): ReplayController {
  let mode = options.mode;
  // A session spans page loads, and each load restarts `seq`; the page id keeps chunk keys unique.
  const page = Math.random().toString(36).slice(2, 10);
  let seq = 0;
  // Events waiting to be uploaded, as JSON: each event is serialised once, and the size is exact.
  let pending: string[] = [];
  let pendingChars = 0;
  let firstTs = 0;
  let lastTs = 0;
  let clicks = 0;
  let errors = 0;
  let lastUpload = 0;
  let uploadTimer: ReturnType<typeof setTimeout> | undefined;
  // In buffer mode, keep the current and previous 30s segments (each starts with a full snapshot).
  let segments: RecordedEvent[][] = [[]];

  function append(event: RecordedEvent): void {
    const json = JSON.stringify(event);
    if (pending.length === 0) firstTs = event.timestamp;
    lastTs = event.timestamp;
    pending.push(json);
    pendingChars += json.length;
    if (isClick(event)) clicks++;
  }

  /** Upload as soon as the rate limit allows. */
  function uploadSoon(): void {
    if (uploadTimer !== undefined) return;
    const wait = lastUpload + MIN_UPLOAD_GAP_MS - Date.now();
    if (wait <= 0) void upload(false);
    else uploadTimer = setTimeout(() => void upload(false), wait);
  }

  async function upload(pageIsHidden: boolean): Promise<void> {
    if (uploadTimer !== undefined) clearTimeout(uploadTimer);
    uploadTimer = undefined;
    if (pending.length === 0) return;
    // Take the chunk and reset the counters before anything asynchronous, so events
    // and errors that arrive during the upload count towards the next chunk.
    const body = `[${pending.join(',')}]`;
    const q = new URLSearchParams({
      project: options.project,
      session: options.sessionId,
      seq: String(seq++),
      page,
      start: String(firstTs),
      end: String(lastTs),
      clicks: String(clicks),
      errors: String(errors),
      href: location.href.split('?')[0]!.slice(0, 500),
    });
    if (options.distinctId) q.set('d', options.distinctId);
    if (options.userId) q.set('u', options.userId);
    pending = [];
    pendingChars = 0;
    clicks = 0;
    errors = 0;
    lastUpload = Date.now();
    const target = (enc: 'gzip' | 'json') => `${options.host}/r?${q}&enc=${enc}`;
    const plain = { 'Content-Type': 'text/plain' };

    try {
      // sendBeacon returns false when the body is over the browser's limit; then try the slower ways.
      if (pageIsHidden && body.length <= BEACON_CHARS && navigator.sendBeacon?.(target('json'), new Blob([body], { type: 'text/plain' }))) return;
      if (typeof CompressionStream === 'undefined') {
        await fetch(target('json'), { method: 'POST', body, headers: plain, keepalive: body.length <= BEACON_CHARS });
        return;
      }
      const gz = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
      // keepalive lets the upload finish if the page navigates away, but only small bodies may use it.
      await fetch(target('gzip'), { method: 'POST', body: new Blob([gz], { type: 'text/plain' }), keepalive: gz.size <= BEACON_CHARS });
    } catch {
      // Network failure: drop the chunk rather than grow memory without bound.
    }
  }

  function onEvent(event: RecordedEvent, isCheckout?: boolean): void {
    if (mode === 'buffer') {
      if (isCheckout) {
        segments.push([]);
        if (segments.length > 2) segments.shift();
      }
      segments[segments.length - 1]!.push(event);
      return;
    }
    append(event);
    // The snapshot is usually the biggest thing on the page: send it now, while the page is still open.
    if (event.type === FULL_SNAPSHOT) void upload(false);
    else if (pendingChars > BEACON_CHARS) uploadSoon();
  }

  const onHide = () => {
    if (document.visibilityState === 'hidden') void upload(true);
  };

  // Everything above must exist before record(): it emits the first snapshot synchronously.
  const stopRecording = record({
    emit: onEvent,
    checkoutEveryNms: mode === 'buffer' ? BUFFER_CHECKOUT_MS : undefined,
    maskAllInputs: true,
    maskTextSelector: options.maskAllText ? '*' : undefined,
    blockSelector: options.blockSelector,
    recordCanvas: false,
    collectFonts: false,
    sampling: { mousemove: 50, scroll: 150, input: 'last' },
  });
  const timer = setInterval(() => void upload(false), CHUNK_MS);
  addEventListener('visibilitychange', onHide);
  addEventListener('pagehide', onHide);

  return {
    stop() {
      stopRecording?.();
      clearInterval(timer);
      removeEventListener('visibilitychange', onHide);
      removeEventListener('pagehide', onHide);
      void upload(true);
    },
    flushBuffer() {
      if (mode !== 'buffer') return;
      mode = 'record';
      for (const event of segments.flat()) append(event);
      segments = [[]];
      void upload(false);
    },
    noteError() {
      errors++;
    },
  };
}

const module: ReplayModule = { startReplay };
window.__glassReplay = module;
