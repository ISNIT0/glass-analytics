/**
 * Site-wide settings. Change SITE_URL when the site moves to its own domain:
 * canonical links, the sitemap, Open Graph tags and llms.txt all follow it.
 */

export const SITE_URL = 'https://dataflare.dev';
export const REPO = 'https://github.com/ISNIT0/glass-analytics';
export const INSTALL = 'npx dataflare-cli init';
export const AGENT_PROMPT =
  "Add Dataflare analytics to this project: run `npx dataflare-cli init`, track signups and purchases, then show me today's visitors.";

/**
 * Dataflare measuring its own site: the deployment in .glass/ (`dataflare init`),
 * upgraded by .github/workflows/glass.yml. Every page loads the SDK in cookieless
 * mode and records every visit for session replay, storing nothing on the device;
 * the copy buttons send events. Empty string removes it.
 */
export const GLASS_HOST = 'https://dataflare-site-analytics.isnit.workers.dev';
export const GLASS_PROJECT = 'dataflare-site';

/**
 * Meta Pixel for the website's own ad measurement (page views, plus the copy
 * events in client/main.ts). It is not a secret: the id is public in every page.
 * Empty string removes it.
 */
export const META_PIXEL_ID = '1857781272315542';

/** "Checked" date shown on comparison pages. Update it when you re-check the facts. */
export const FACTS_CHECKED = 'November 2026';
