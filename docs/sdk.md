# Browser SDK

Two ways to load it, with the same API:

- **Script tag** (served by your Worker, no build step): `<script defer src="https://<host>/s.js" data-project="my-app"></script>`, then use `window.glass`.
- **npm**: `npm i dataflare-web`, then `import { glass } from 'dataflare-web'` and call `glass.init({ host, project })`.

The SDK is about 4 KB gzipped and has no dependencies. Session replay loads a separate recorder from your Worker only for recorded sessions.

## `glass.init(options)`

| Option            | Default          |                                                                                                                                                                                                           |
| ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`            | required         | Your Worker URL, e.g. `https://glass.acme.workers.dev` or `/_glass`                                                                                                                                       |
| `project`         | required         | Project id                                                                                                                                                                                                |
| `persistence`     | `'localStorage'` | `'cookieless'` stores nothing on the device (see [privacy.md](privacy.md))                                                                                                                                |
| `autocapture`     | `true`           | `false`, or `{ pageviews, clicks, errors, webVitals }` to pick                                                                                                                                            |
| `replay`          | off              | `{ sampleRate: 0.1, onErrorSampleRate: 1, maskAllText: false, maskTextSelector: '[data-glass-mask]', blockSelector: '[data-glass-block]', console: ['warn', 'error'], network: true, cookieless: false }` |
| `flags`           | `true`           | Load feature flags on init                                                                                                                                                                                |
| `beforeSend`      |                  | `(event) => event                                                                                                                                                                                         | null` to edit or drop events |
| `flushIntervalMs` | `5000`           | How often queued events are sent                                                                                                                                                                          |
| `debug`           | `false`          | Log events to the console                                                                                                                                                                                 |

Script tag equivalents: `data-project`, `data-host`, `data-persistence="cookieless"`, `data-autocapture="false"`, `data-replay-sample-rate="0.1"`, `data-replay-on-error-sample-rate="1"`, `data-replay-console="false"` (or `"all"`), `data-replay-network="false"`, `data-replay-mask-all-text="true"`, `data-replay-cookieless="true"`, `data-debug="true"`.

## Events

```js
glass.capture('invite_sent', { role: 'editor', count: 3 });
```

Events are batched and sent every few seconds, when 20 are waiting, and when the page is hidden (with `sendBeacon`, so nothing is lost on navigation). Names starting with `$` are reserved.

Automatic events:

| Event         | When                                          | Properties                                   |
| ------------- | --------------------------------------------- | -------------------------------------------- |
| `$pageview`   | Load and client-side navigation (History API) |                                              |
| `$pageleave`  | Leaving a page                                | `duration_ms`                                |
| `$click`      | Clicks on links, buttons, `[role=button]`     | `tag`, `text`, `href`, `outbound`            |
| `$exception`  | Uncaught errors, unhandled rejections         | `type`, `message`, `stack`                   |
| `$web_vitals` | Page hidden                                   | `metric` (LCP, CLS, INP, FCP, TTFB), `value` |
| `$exposure`   | First `glass.flag(key)` read on a page        | `flag`, `variant`                            |

Add `data-glass-no-capture` to an element to exclude it from click capture. Add `data-glass-event="name"` (and `data-glass-prop-*` attributes) to send a custom event on click instead.

## People

```js
glass.identify(user.id, { plan: 'pro' }); // after login: links this device to the user
glass.setPersonProperties({ plan: 'team' }); // update properties
glass.setPersonProperties({ first_source: 'ad' }, true); // only if not already set
glass.reset(); // on logout: new anonymous id
```

Events sent before `identify()` on the same device count towards that user in every report, so a funnel like "visited pricing → signed up" connects across signup. Person properties are copied onto each event when it's received, so `person.plan` filters reflect the plan at the time of the event.

## Feature flags

```js
glass.onFlags(() => {
  if (glass.flag('new-checkout') === 'test') showNewCheckout();
});
glass.isEnabled('beta-editor'); // true / false
glass.flags(); // all values, without recording exposures
```

`glass.flag(key)` returns `"on"` for a simple flag, the variant key for a multivariate flag, or `null`. The first read on a page records an `$exposure` event, which experiments count, so read the flag where the variant is actually shown. Values are cached on the device, so returning visitors get them instantly. Flags are evaluated by your Worker, so targeting rules are never sent to browsers.

## Session replay

Turn it on with a sample rate. Inputs are always masked; `maskAllText` masks all text; elements matching `blockSelector` aren't recorded at all.

```js
glass.init({ host, project, replay: { sampleRate: 0.1, onErrorSampleRate: 1 } });
glass.startReplay(); // record this session regardless of sampling
glass.stopReplay();
```

`onErrorSampleRate` keeps the last minute in memory and uploads it only if an error happens, so you get the run-up to every error without recording everything.

Besides the page, recordings carry what developers need to debug:

- **Console messages**: `warn` and `error` by default. `console: true` records every level, `console: false` none. Your code's log messages can contain personal data, so only turn on routine levels if you need them.
- **Network requests**: method, URL (without the query string), status and timing of `fetch` and `XMLHttpRequest` calls. Never headers or bodies. `network: false` turns it off.
- **Client-side navigation**, so single-page apps show the right URL in the player.

Mark elements whose text should be masked with `data-glass-mask`, and elements to leave out entirely with `data-glass-block`.

Each session gets a timeline: labelled clicks (with a CSS selector you can search your code for), rage clicks, dead clicks (a click on a control after which nothing changed), clicks followed by an error, errors with stack frames, failed and slow requests, and console errors. The dashboard player shows it beside the recording, and agents read it with `summarise_replay`.

## Consent

```js
glass.init({ host, project, persistence: 'cookieless' }); // before consent
glass.consent(true); // after the user agrees: switch to a persistent id, allow replay
glass.consent(false); // delete stored ids, stop replay, go back to cookieless
```

Replay normally waits for consent. With `replay: { sampleRate: 1, cookieless: true }` (`data-replay-cookieless="true"`) it also records cookieless visitors, storing nothing on the device; the Worker files each page load under the visit's cookieless ids. `consent(false)` stops it for the rest of the page, so call it on load for visitors who rejected earlier.

## Server-side events

Send events from your backend with a plain POST:

```js
await fetch('https://glass.acme.workers.dev/e', {
  method: 'POST',
  body: JSON.stringify({
    project: 'my-app',
    events: [
      {
        id: crypto.randomUUID(),
        event: 'invoice_paid',
        ts: Date.now(),
        distinct_id: user.id,
        user_id: user.id,
        props: { amount: 49 },
      },
    ],
  }),
});
```
