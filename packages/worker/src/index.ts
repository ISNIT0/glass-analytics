/**
 * Cloudflare Worker entry point.
 *
 * The SDK, replay recorder and dashboard bundles are injected as
 * `__GLASS_ASSETS__` by scripts/build.ts, so the deployed Worker is a single
 * self-contained file.
 */

import { createApp } from './app.ts';
import type { Assets } from './env.ts';

declare const __GLASS_ASSETS__: Assets;

export default createApp({ assets: __GLASS_ASSETS__ });
