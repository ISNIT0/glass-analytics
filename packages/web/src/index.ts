/**
 * @glassanalytics/web — the Glass browser SDK.
 *
 * ```ts
 * import { glass } from '@glassanalytics/web';
 *
 * glass.init({ host: 'https://glass.acme.workers.dev', project: 'acme' });
 * glass.capture('signup_completed', { plan: 'pro' });
 * glass.identify(user.id, { plan: 'pro' });
 * if (glass.flag('new-checkout') === 'test') showNewCheckout();
 * ```
 *
 * No build step? Use the script tag the Worker serves instead:
 * `<script defer src="https://glass.acme.workers.dev/s.js" data-project="acme"></script>`
 */

import { Glass } from './client.ts';

export { Glass };
export type {
  AutocaptureOptions,
  ConsoleLevel,
  GlassOptions,
  Persistence,
  ReplayOptions,
  WireEvent,
} from './types.ts';

/** The default client. Call `glass.init()` once, as early as possible. */
export const glass = new Glass();
