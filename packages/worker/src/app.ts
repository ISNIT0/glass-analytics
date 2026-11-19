/**
 * The Worker application: routing for every public path.
 *
 *   /e /r /f          ingest events, replay chunks, flag evaluation (public)
 *   /s.js /replay.js  the browser SDK and replay recorder
 *   /app              the dashboard
 *   /api/*            JSON API (API key)
 *   /mcp              MCP server (API key)
 *   /llms.txt         agent instructions for this deployment
 *   /health           status
 *
 * All paths also work under a `/_glass` prefix, so Dataflare can be mounted on
 * your own domain (first-party requests are not blocked by ad blockers).
 */

import { trimTrailingSlashes } from '@dataflare/core/url';
import { apiRouter } from './api.ts';
import { requireScope } from './auth.ts';
import { isHourlyTick, runMaintenance } from './cron.ts';
import { consumeDeliveries, type DeliveryMessage } from './destinations.ts';
import type { Assets, Env, MessageBatch } from './env.ts';
import { registerExtensions } from './extensions.ts';
import { handleFlagEvaluation } from './flags.ts';
import { CORS_HEADERS, errorResponse, HttpError, json } from './http.ts';
import { handleIngest } from './ingest.ts';
import { llmsTxt } from './llms.ts';
import { handleMcp } from './mcp/server.ts';
import { handleReplayChunk } from './replays.ts';
import { handleStripeWebhook } from './revenue.ts';
import { GlassService } from './service.ts';
import { D1Store } from './stores/d1.ts';
import { LakeStore } from './stores/lake.ts';
import type { EventStore } from './stores/types.ts';

export const MOUNT_PREFIX = '/_glass';

export interface AppOptions {
  assets: Assets;
  /** Override store creation (tests). */
  createStore?: (env: Env) => EventStore;
  now?: () => number;
}

export function createStore(env: Env): EventStore {
  return env.GLASS_STORE === 'lake' ? new LakeStore(env) : new D1Store(env.DB);
}

function withCors(response: Response): Response {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

/** The Dataflare mark, a pane with a green fill line. Keep in sync with site/public/favicon.svg. */
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset=".58" stop-color="#fff"/><stop offset=".58" stop-color="#cfe7df"/><stop offset=".78" stop-color="#cfe7df"/><stop offset=".78" stop-color="#2e7d6b"/></linearGradient></defs><rect x="2" y="2" width="28" height="28" rx="7" fill="url(#g)" stroke="#2e7d6b" stroke-width="2.5"/></svg>',
)}`;

function dashboardHtml(base: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="glass-base" content="${base}">
<title>Dataflare</title>
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="${base}/app/app.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="${base}/app/app.js"></script>
</body>
</html>`;
}

const DASHBOARD_CSP =
  "default-src 'self'; img-src * data: blob:; style-src * 'unsafe-inline'; font-src * data:; frame-src 'self' blob: about:; connect-src 'self'; script-src 'self'";

/** One request, with what every route needs. */
interface RequestContext {
  request: Request;
  env: Env;
  url: URL;
  /** "/_glass" when mounted under the site's own domain, else "". */
  prefix: string;
  path: string;
  /** The public URL of this deployment, for links. */
  base: string;
  store: EventStore;
  service: GlassService;
  now: number;
  options: AppOptions;
}

function requestContext(
  request: Request,
  env: Env,
  options: AppOptions,
  makeStore: (env: Env) => EventStore,
): RequestContext {
  const url = new URL(request.url);
  const mounted = url.pathname === MOUNT_PREFIX || url.pathname.startsWith(`${MOUNT_PREFIX}/`);
  const prefix = mounted ? MOUNT_PREFIX : '';
  const base = env.GLASS_PUBLIC_URL
    ? trimTrailingSlashes(env.GLASS_PUBLIC_URL)
    : `${url.origin}${prefix}`;
  const store = makeStore(env);
  return {
    request,
    env,
    url,
    prefix,
    path: url.pathname.slice(prefix.length) || '/',
    base,
    store,
    service: new GlassService(env, store, base),
    now: options.now?.() ?? Date.now(),
    options,
  };
}

type Route = (c: RequestContext) => Response | null | Promise<Response | null>;

const accepted = () => new Response(null, { status: 204, headers: CORS_HEADERS });

/** A route that only takes POST; other methods fall through (and end in a 404). */
const post =
  (handle: (c: RequestContext) => Promise<Response>): Route =>
  (c) =>
    c.request.method === 'POST' ? handle(c) : null;

const html = (body: string) =>
  new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': DASHBOARD_CSP,
      'Cache-Control': 'no-cache',
    },
  });

const ROUTES: Record<string, Route> = {
  '/': (c) => Response.redirect(`${c.url.origin}${c.prefix}/app`, 302),
  '/health': async (c) => withCors(json(await c.service.health())),
  '/e': post(async (c) => {
    await handleIngest(c.request, c.env, c.store, c.now, c.base);
    return accepted();
  }),
  '/r': post(async (c) => {
    await handleReplayChunk(c.request, c.env, c.url);
    return accepted();
  }),
  '/f': post(async (c) => withCors(json(await handleFlagEvaluation(c.request, c.env)))),
  '/s.js': (c) => script(c.options.assets.sdk, 300),
  '/replay.js': (c) => script(c.options.assets.replay, 3600),
  '/llms.txt': (c) =>
    new Response(llmsTxt(c.base, c.store.kind), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }),
  '/app': (c) => html(dashboardHtml(c.prefix)),
  '/app/': (c) => html(dashboardHtml(c.prefix)),
  '/app/app.js': (c) =>
    new Response(c.options.assets.dashboardJs, {
      headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
    }),
  '/app/app.css': (c) =>
    new Response(c.options.assets.dashboardCss, {
      headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' },
    }),
  '/mcp': async (c) => {
    const scope = await requireScope(c.request, c.env, 'read');
    const actorName = c.request.headers.get('X-Glass-Actor')?.slice(0, 60);
    c.service.actor = actorName ? `${actorName} (MCP, ${scope} key)` : `MCP, ${scope} key`;
    return withCors(await handleMcp(c.request, c.service, scope));
  },
};

/** Stripe webhooks (authenticated by their signature, not an API key), then the API. */
async function stripeOrApi(c: RequestContext): Promise<Response | null> {
  const stripe = /^\/hooks\/stripe\/([A-Za-z0-9_-]{1,64})\/?$/.exec(c.path);
  if (stripe && c.request.method === 'POST')
    return json(await handleStripeWebhook(c.request, c.env, c.store, stripe[1]!, c.base, c.now));
  if (c.path !== '/api' && !c.path.startsWith('/api/')) return null;
  const router = await apiRouter(c.service, c.env, c.request, c.now);
  const response = await router.handle(c.request, c.url, c.path);
  return response ? withCors(response) : null;
}

export function createApp(options: AppOptions) {
  registerExtensions();
  const makeStore = options.createStore ?? createStore;

  async function fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    const c = requestContext(request, env, options, makeStore);
    try {
      const route = Object.hasOwn(ROUTES, c.path) ? ROUTES[c.path] : undefined;
      const routed = (await route?.(c)) ?? (await stripeOrApi(c));
      if (routed) return routed;
      throw new HttpError(404, `Nothing at ${c.path}`, `See ${c.base}/api or ${c.base}/llms.txt`);
    } catch (err) {
      return withCors(errorResponse(err));
    }
  }

  async function scheduled(controller: { cron?: string } | undefined, env: Env): Promise<void> {
    const now = options.now?.() ?? Date.now();
    const result = await runMaintenance(env, makeStore(env), now, {
      hourly: isHourlyTick(controller?.cron, now),
    });
    console.log('[glass] maintenance', JSON.stringify(result));
  }

  /** Destination deliveries (Cloudflare Queues consumer). */
  async function queue(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
    await consumeDeliveries(batch, env);
  }

  return { fetch, scheduled, queue };
}

function script(source: string, maxAge: number): Response {
  return new Response(source, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}
