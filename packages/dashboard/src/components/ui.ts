/**
 * Shared building blocks: panels (with their SQL pane), buttons, states.
 *
 * Every panel that shows a number can show the SQL that produced it. With
 * "Show SQL" on (top bar, or press "s"), the queries appear under each panel.
 */

import { ApiError } from '../api.ts';
import { type Child, h, mount } from '../dom.ts';

export interface PanelOptions {
  /** Queries behind this panel, shown in the SQL pane. */
  sql?: string[];
  /** Extra controls in the panel header. */
  actions?: Child;
  class?: string;
}

export function panel(title: string, body: Child, options: PanelOptions = {}): HTMLElement {
  return h(
    'section',
    { class: `panel ${options.class ?? ''}` },
    h('header', { class: 'panel-head' }, h('h2', {}, title), options.actions ? h('div', { class: 'panel-actions' }, options.actions) : null),
    h('div', { class: 'panel-body' }, body),
    options.sql?.length ? sqlPane(options.sql) : null,
  );
}

export function sqlPane(queries: string[]): HTMLElement {
  return h(
    'div',
    { class: 'sql-pane' },
    h('div', { class: 'sql-pane-head' }, h('span', {}, queries.length === 1 ? 'Query' : `${queries.length} queries`), copyButton(queries.join(';\n\n'), 'Copy SQL')),
    ...queries.map((q) => h('pre', { class: 'sql' }, h('code', {}, q.trim()))),
  );
}

export function copyButton(text: string | (() => string), label = 'Copy'): HTMLButtonElement {
  const button = h('button', { class: 'ghost small', type: 'button' }, label);
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => {
      button.textContent = label;
    }, 1500);
  });
  return button;
}

export function loading(label = 'Loading'): HTMLElement {
  return h('div', { class: 'state loading', role: 'status' }, label);
}

export function empty(message: string, action?: Child): HTMLElement {
  return h('div', { class: 'state empty' }, h('p', {}, message), action ?? null);
}

export function errorState(err: unknown): HTMLElement {
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof ApiError ? err.hint : undefined;
  return h('div', { class: 'state error', role: 'alert' }, h('p', {}, message), hint ? h('p', { class: 'hint' }, hint) : null);
}

/** Render a page section asynchronously: shows loading, then the result or an error. */
export function later(render: () => Promise<Child>, label?: string): HTMLElement {
  const holder = h('div', { class: 'later' }, loading(label));
  render().then(
    (content) => mount(holder, content),
    (err: unknown) => mount(holder, errorState(err)),
  );
  return holder;
}

export function pageHeader(title: string, description?: string, actions?: Child): HTMLElement {
  return h(
    'div',
    { class: 'page-head' },
    h('div', {}, h('h1', {}, title), description ? h('p', { class: 'muted' }, description) : null),
    actions ? h('div', { class: 'page-actions' }, actions) : null,
  );
}

export function table(headers: string[], rows: Child[][], options: { numeric?: number[]; class?: string } = {}): HTMLElement {
  const numeric = new Set(options.numeric ?? []);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: options.class ?? '' },
      h('thead', {}, h('tr', {}, headers.map((x, i) => h('th', { class: numeric.has(i) ? 'num' : '' }, x)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((cell, i) => h('td', { class: numeric.has(i) ? 'num' : '' }, cell))))),
    ),
  );
}

/** A segmented control for switching between a few views of the same data. */
export function tabs<T extends string>(options: { value: T; label: string }[], selected: T, onSelect: (value: T) => void): HTMLElement {
  return h(
    'div',
    { class: 'tabs', role: 'tablist' },
    options.map((o) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(o.value === selected),
          class: o.value === selected ? 'tab active' : 'tab',
          onclick: () => onSelect(o.value),
        },
        o.label,
      ),
    ),
  );
}

export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
