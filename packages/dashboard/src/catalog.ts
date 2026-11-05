/**
 * Cached event taxonomy for pickers: list + per-event detail (description,
 * properties), person properties, and property values for typeahead. Shared
 * so every picker on a page hits the API once.
 */

import { api } from './api.ts';

export interface CatalogEvent {
  event: string;
  count: number;
  lastSeen: string;
  description: string;
  system: boolean;
}

export interface CatalogProperty {
  name: string;
  types: string[];
  coverage: number;
  examples: string[];
  description: string;
}

export interface CatalogEventDetail {
  event: string;
  description: string;
  owner: string;
  sampled: number;
  lastSeen: string | null;
  properties: CatalogProperty[];
}

export interface PropertyValue {
  value: string;
  /** Display text (a cohort's name; otherwise the value itself). */
  label: string;
  /** Events with this value in the window (null for cohorts). */
  count: number | null;
  /** Distinct people with this value. */
  people: number | null;
}

const SYSTEM_DOCS: Record<string, string> = {
  $pageview: 'Automatic page view captured by the Dataflare snippet whenever the URL changes.',
  $pageleave: 'Fired when the user leaves a page (tab hide or navigation). Used for time-on-page.',
  $click: 'Automatic click on links, buttons and elements with data-glass-event.',
  $exception: 'Uncaught JavaScript error or unhandled promise rejection.',
  $web_vitals: 'Core Web Vitals (LCP, CLS, INP) reported by the browser.',
  $identify: 'Links an anonymous device to your user id via glass.identify().',
  $set: 'Updates person properties without changing identity.',
  $exposure: 'Someone was assigned a feature-flag variant (used by experiments).',
};

/** Built-in columns commonly used for breakdowns and filters. */
export const COLUMN_OPTIONS: {
  name: string;
  description: string;
  group: 'Page' | 'Acquisition' | 'Geo' | 'Device' | 'Identity';
}[] = [
  { name: 'path', description: 'URL path of the page, e.g. /pricing.', group: 'Page' },
  { name: 'host', description: 'Hostname of the page URL.', group: 'Page' },
  { name: 'url', description: 'Full page URL including query string.', group: 'Page' },
  { name: 'title', description: 'document.title at capture time.', group: 'Page' },
  {
    name: 'referrer_host',
    description: 'Hostname of the referrer, e.g. news.ycombinator.com.',
    group: 'Acquisition',
  },
  { name: 'referrer', description: 'Full referrer URL (query stripped).', group: 'Acquisition' },
  { name: 'utm_source', description: 'utm_source query parameter.', group: 'Acquisition' },
  { name: 'utm_medium', description: 'utm_medium query parameter.', group: 'Acquisition' },
  { name: 'utm_campaign', description: 'utm_campaign query parameter.', group: 'Acquisition' },
  { name: 'utm_term', description: 'utm_term query parameter.', group: 'Acquisition' },
  { name: 'utm_content', description: 'utm_content query parameter.', group: 'Acquisition' },
  { name: 'country', description: 'ISO country from the request edge (Cloudflare).', group: 'Geo' },
  { name: 'region', description: 'Region / subdivision from the request edge.', group: 'Geo' },
  { name: 'city', description: 'City from the request edge.', group: 'Geo' },
  { name: 'device', description: 'desktop, mobile or tablet.', group: 'Device' },
  { name: 'browser', description: 'Browser family: Chrome, Safari, Firefox, …', group: 'Device' },
  { name: 'os', description: 'Operating system family.', group: 'Device' },
  {
    name: 'distinct_id',
    description: 'Anonymous device id (stable across identify).',
    group: 'Identity',
  },
  { name: 'user_id', description: 'Your user id after glass.identify().', group: 'Identity' },
  {
    name: 'person_id',
    description: 'Resolved person id (user_id or distinct_id).',
    group: 'Identity',
  },
  { name: 'session_id', description: 'Browser session id.', group: 'Identity' },
];

let listCache = new Map<string, Promise<CatalogEvent[]>>();
let detailCache = new Map<string, Promise<CatalogEventDetail>>();
let personCache = new Map<string, Promise<CatalogProperty[]>>();
let valuesCache = new Map<string, Promise<PropertyValue[]>>();

function projectKey(project?: string): string {
  return project ?? '';
}

export function invalidateCatalog(): void {
  listCache = new Map();
  detailCache = new Map();
  personCache = new Map();
  valuesCache = new Map();
}

/** Forget cached values of one property (e.g. "cohort" after saving a cohort). */
export function invalidateValues(property: string): void {
  for (const key of valuesCache.keys())
    if (key.split('::')[1] === property) valuesCache.delete(key);
}

export function loadEvents(project?: string): Promise<CatalogEvent[]> {
  const key = projectKey(project);
  let pending = listCache.get(key);
  if (!pending) {
    pending = api
      .get<{ events: CatalogEvent[] }>('/api/events', { project, days: 30 })
      .then((r) =>
        r.events.map((e) => ({
          ...e,
          description: e.description || SYSTEM_DOCS[e.event] || '',
        })),
      )
      .catch(() => []);
    listCache.set(key, pending);
  }
  return pending;
}

export function loadEventDetail(event: string, project?: string): Promise<CatalogEventDetail> {
  const key = `${projectKey(project)}::${event}`;
  let pending = detailCache.get(key);
  if (!pending) {
    pending = api
      .get<CatalogEventDetail>(`/api/events/${encodeURIComponent(event)}`, { project })
      .then((d) => ({
        ...d,
        description: d.description || SYSTEM_DOCS[d.event] || '',
      }))
      .catch(() => ({
        event,
        description: SYSTEM_DOCS[event] || '',
        owner: '',
        sampled: 0,
        lastSeen: null,
        properties: [],
      }));
    detailCache.set(key, pending);
  }
  return pending;
}

/** Person property names as `person.<name>`, sampled from recently active people. */
export function loadPersonProperties(project?: string): Promise<CatalogProperty[]> {
  const key = projectKey(project);
  let pending = personCache.get(key);
  if (!pending) {
    pending = api
      .get<{ properties: CatalogProperty[] }>('/api/person-properties', { project })
      .then((r) => r.properties)
      .catch(() => []);
    personCache.set(key, pending);
  }
  return pending;
}

/** Most common values of a property (optionally on one event, containing `query`). */
export function loadPropertyValues(
  property: string,
  options: { event?: string; project?: string; query?: string } = {},
): Promise<PropertyValue[]> {
  const query = options.query?.trim().toLowerCase() ?? '';
  const key = [projectKey(options.project), property, options.event ?? '', query].join('::');
  let pending = valuesCache.get(key);
  if (!pending) {
    pending = api
      .get<{ values: PropertyValue[] }>('/api/properties/values', {
        project: options.project,
        property,
        event: options.event,
        query,
        limit: 50,
      })
      .then((r) => r.values)
      .catch(() => {
        valuesCache.delete(key);
        return [];
      });
    valuesCache.set(key, pending);
  }
  return pending;
}

export function systemEventDoc(event: string): string {
  return SYSTEM_DOCS[event] ?? '';
}
