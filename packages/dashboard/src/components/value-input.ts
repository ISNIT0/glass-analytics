/**
 * Amplitude-style value selector for filters: chips for the chosen values and a
 * typeahead of the values that actually occur (with people counts). Typing a
 * value that has not been seen yet is always allowed.
 */

import { type PropertyValue, loadPropertyValues } from '../catalog.ts';
import { h, mount } from '../dom.ts';
import { count } from '../format.ts';
import { scope } from '../state.ts';
import { closeActivePicker, positionPop } from './picker.ts';

export interface ValueInputOptions {
  property: string;
  values: string[];
  /** Chips with checkboxes (is / is not). False picks one value (contains). */
  multiple: boolean;
  onChange: (values: string[]) => void;
  event?: string;
  project?: string;
  placeholder?: string;
}

type Row = { value: string; label: string; meta: string; add?: boolean };

export function valueInput(options: ValueInputOptions): HTMLElement {
  const project = options.project ?? scope().project;
  const placeholder =
    options.placeholder ?? (options.property ? 'Select values' : 'Pick a property first');
  let selected = [...options.values];
  const labels = new Map<string, string>();
  const root = h('div', { class: 'picker value-input', 'aria-label': 'Filter value' });
  const trigger = h('div', {
    class: 'picker-trigger value-trigger',
    role: 'button',
    tabindex: 0,
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  });
  root.append(trigger);

  const commit = (next: string[]) => {
    selected = next;
    paintTrigger();
    options.onChange([...selected]);
  };

  const paintTrigger = () => {
    trigger.classList.toggle('empty', selected.length === 0);
    mount(
      trigger,
      selected.length === 0
        ? h('span', { class: 'picker-trigger-value' }, placeholder)
        : h(
            'span',
            { class: 'value-chips' },
            selected.map((v) =>
              h(
                'span',
                { class: 'value-chip' },
                h('span', { class: 'value-chip-label' }, labels.get(v) ?? v),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'value-chip-remove',
                    'aria-label': `Remove ${labels.get(v) ?? v}`,
                    onclick: (e: Event) => {
                      e.stopPropagation();
                      commit(selected.filter((x) => x !== v));
                    },
                  },
                  '×',
                ),
              ),
            ),
          ),
      h('span', { class: 'picker-chevron', 'aria-hidden': 'true' }, '▾'),
    );
  };

  const remember = (values: PropertyValue[]) => {
    for (const v of values) if (v.label !== v.value) labels.set(v.value, v.label);
  };

  const open = () => {
    if (!options.property) return;
    closeActivePicker();
    root.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    const before = JSON.stringify(selected);

    const search = h('input', {
      type: 'search',
      class: 'picker-search',
      placeholder: options.multiple ? 'Search or type values…' : 'Search or type a value…',
      'aria-label': 'Search values',
      autocomplete: 'off',
    }) as HTMLInputElement;
    const listEl = h('div', {
      class: 'picker-list value-list',
      role: 'listbox',
      'aria-multiselectable': String(options.multiple),
    });
    const foot = h('div', { class: 'value-foot' });
    const pop = h(
      'div',
      {
        class: 'picker-pop value-pop',
        role: 'dialog',
        'aria-label': `Values of ${options.property}`,
      },
      search,
      listEl,
      foot,
    );
    document.body.append(pop);
    positionPop(trigger, pop, 420);
    search.focus();

    let suggestions: PropertyValue[] = [];
    let loadingValues = true;
    let activeIndex = 0;
    let req = 0;

    const rows = (): Row[] => {
      const q = search.value.trim();
      const ql = q.toLowerCase();
      const out: Row[] = [];
      const seen = new Set<string>();
      const add = (value: string, label: string, meta: string) => {
        if (seen.has(value)) return;
        seen.add(value);
        out.push({ value, label, meta });
      };
      // Chosen values stay at the top so they can be unticked.
      for (const v of selected)
        if (!ql || v.toLowerCase().includes(ql) || (labels.get(v) ?? '').toLowerCase().includes(ql))
          add(v, labels.get(v) ?? v, '');
      for (const s of suggestions) {
        if (ql && !s.value.toLowerCase().includes(ql) && !s.label.toLowerCase().includes(ql))
          continue;
        add(
          s.value,
          s.label,
          s.people != null ? `${count(s.people)} ${s.people === 1 ? 'person' : 'people'}` : '',
        );
      }
      if (q && !seen.has(q) && options.property !== 'cohort')
        out.unshift({ value: q, label: `Add “${q}”`, meta: 'new', add: true });
      return out;
    };

    const paint = () => {
      const list = rows();
      activeIndex = Math.max(0, Math.min(activeIndex, list.length - 1));
      mount(
        listEl,
        list.length === 0
          ? h(
              'p',
              { class: 'picker-empty muted' },
              loadingValues
                ? 'Loading values…'
                : options.property === 'cohort'
                  ? 'No saved cohorts yet. Create one on the People tab.'
                  : 'No values seen in the last 30 days. Type one to add it.',
            )
          : list.map((r, i) => {
              const on = selected.includes(r.value);
              return h(
                'button',
                {
                  type: 'button',
                  class: `picker-item value-item${i === activeIndex ? ' active' : ''}${on ? ' selected' : ''}`,
                  role: 'option',
                  'aria-selected': String(on),
                  onmouseenter: () => {
                    activeIndex = i;
                    listEl.querySelectorAll('.picker-item').forEach((el, j) => {
                      el.classList.toggle('active', j === i);
                    });
                  },
                  onclick: (e: Event) => {
                    e.preventDefault();
                    choose(r);
                  },
                },
                options.multiple
                  ? h(
                      'span',
                      { class: `value-check${on ? ' on' : ''}`, 'aria-hidden': 'true' },
                      on ? '✓' : '',
                    )
                  : null,
                h('span', { class: 'picker-item-name' }, r.label),
                r.meta ? h('span', { class: 'picker-item-meta' }, r.meta) : null,
              );
            }),
      );
      listEl
        .querySelector<HTMLElement>('.picker-item.active')
        ?.scrollIntoView({ block: 'nearest' });
      mount(
        foot,
        h(
          'span',
          { class: 'muted small' },
          options.multiple
            ? `${selected.length} selected · matches any`
            : 'Enter to use the typed value',
        ),
        options.multiple
          ? h(
              'button',
              { type: 'button', class: 'primary small', onclick: () => cleanup() },
              'Done',
            )
          : null,
      );
    };

    const choose = (r: Row) => {
      if (!options.multiple) {
        selected = [r.value];
        cleanup();
        return;
      }
      selected = selected.includes(r.value)
        ? selected.filter((v) => v !== r.value)
        : [...selected, r.value];
      if (r.add) search.value = '';
      paintTrigger();
      paint();
      search.focus();
    };

    const fetchValues = () => {
      const id = ++req;
      loadingValues = true;
      void loadPropertyValues(options.property, {
        event: options.event,
        project,
        query: search.value,
      }).then((values) => {
        if (id !== req) return;
        loadingValues = false;
        suggestions = values;
        remember(values);
        paintTrigger();
        paint();
      });
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    search.addEventListener('input', () => {
      activeIndex = 0;
      paint();
      clearTimeout(timer);
      timer = setTimeout(fetchValues, 150);
    });

    const onKey = (e: KeyboardEvent) => {
      const list = rows();
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = Math.min(list.length - 1, activeIndex + 1);
        paint();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(0, activeIndex - 1);
        paint();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const r = list[activeIndex];
        if (r) choose(r);
        else if (!options.multiple || !search.value.trim()) cleanup();
      } else if (e.key === 'Backspace' && options.multiple && !search.value && selected.length) {
        selected = selected.slice(0, -1);
        paintTrigger();
        paint();
      }
    };
    const onDoc = (e: MouseEvent) => {
      if (e.target instanceof Node && (pop.contains(e.target) || root.contains(e.target))) return;
      cleanup();
    };
    const onResize = () => positionPop(trigger, pop, 420);

    const cleanup = () => {
      clearTimeout(timer);
      pop.remove();
      root.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onDoc, true);
      paintTrigger();
      if (JSON.stringify(selected) !== before) options.onChange([...selected]);
    };

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('mousedown', onDoc, true);
    paint();
    fetchValues();
  };

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    open();
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      open();
    }
  });

  paintTrigger();
  // Cohort chips store keys; show names once they load.
  if (options.property === 'cohort' && selected.length) {
    void loadPropertyValues('cohort', { project }).then((values) => {
      remember(values);
      paintTrigger();
    });
  }
  return root;
}
