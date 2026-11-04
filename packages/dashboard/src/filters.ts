/**
 * Dashboard filters live in the URL as repeated `f=property:value` params,
 * e.g. `#/reports?f=path:/pricing&f=country:GB`, so filtered views can be shared
 * and constructed by agents.
 */

import { h } from './dom.ts';
import { currentRoute, go } from './state.ts';

export interface UrlFilter {
  property: string;
  value: string;
}

export function urlFilters(): UrlFilter[] {
  return currentRoute()
    .params.getAll('f')
    .map((f) => {
      const i = f.indexOf(':');
      return i > 0 ? { property: f.slice(0, i), value: f.slice(i + 1) } : null;
    })
    .filter((f): f is UrlFilter => f !== null);
}

export function filterHref(property: string, value: string): string {
  const route = currentRoute();
  const params = new URLSearchParams(route.params);
  params.append('f', `${property}:${value}`);
  return `#/${[route.page, ...route.rest].join('/')}?${params}`;
}

/** Filters as API filter objects. */
export function apiFilters(): { property: string; value: string }[] {
  return urlFilters().map((f) => ({ property: f.property, value: f.value }));
}

export function filterChips(): HTMLElement | null {
  const filters = urlFilters();
  if (filters.length === 0) return null;
  const route = currentRoute();
  return h(
    'div',
    { class: 'chips', 'aria-label': 'Active filters' },
    filters.map((f) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip',
          title: 'Remove filter',
          onclick: () => {
            const params = new URLSearchParams(route.params);
            const rest = params.getAll('f').filter((x) => x !== `${f.property}:${f.value}`);
            params.delete('f');
            for (const x of rest) params.append('f', x);
            go([route.page, ...route.rest].join('/'), Object.fromEntries(params), false);
          },
        },
        f.property.startsWith('session.')
          ? `visits where ${f.property.slice(8)} is ${f.value}`
          : `${f.property} is ${f.value}`,
        h('span', { 'aria-hidden': 'true' }, ' ×'),
      ),
    ),
  );
}
