/**
 * Behaviour shared by every page: copy buttons, the mobile menu, the product
 * tour tabs and the hero's SQL switch. Each part works without the others,
 * and the page reads fine with no JavaScript at all.
 */

declare global {
  interface Window {
    glass?: { capture(event: string, props?: Record<string, unknown>): void };
    fbq?: (command: string, event: string, props?: Record<string, unknown>) => void;
  }
}

/** Events that mean someone is about to install: sent to the Meta Pixel too, as custom events. */
const META_EVENTS = new Set(['install_command_copied', 'agent_prompt_copied', 'demo_opened']);

const track = (event: string, props?: Record<string, unknown>) => {
  window.glass?.capture(event, props);
  if (META_EVENTS.has(event)) window.fbq?.('trackCustom', event, { page: location.pathname });
};

// Copy buttons
for (const button of document.querySelectorAll<HTMLButtonElement>(
  'button[data-copy], button[data-copy-from]',
)) {
  const label = button.textContent;
  button.addEventListener('click', async () => {
    const text =
      button.dataset.copy ??
      document.getElementById(button.dataset.copyFrom ?? '')?.textContent?.trim() ??
      '';
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
      button.classList.add('copied');
      track(button.dataset.event ?? 'copied', { text: text.slice(0, 80), page: location.pathname });
    } catch {
      button.textContent = 'Select and copy';
    }
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove('copied');
    }, 1600);
  });
}

// Links that carry an analytics event
for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-event]'))
  link.addEventListener('click', () => track(link.dataset.event!, { page: location.pathname }));

// Mobile menu
const menuButton = document.querySelector<HTMLButtonElement>('.menu-button');
const mobileNav = document.getElementById('mobile-nav');
menuButton?.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!open));
  if (mobileNav) mobileNav.hidden = open;
});

// Product tour tabs (WAI-ARIA tabs; without JS every panel shows, stacked)
const tablist = document.querySelector<HTMLElement>('.tour [role="tablist"]');
if (tablist) {
  document.documentElement.classList.add('tabs-ready');
  const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (tab: HTMLButtonElement, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls')!);
      if (panel) panel.toggleAttribute('data-inactive', !on);
    }
    if (focus) tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      select(tab);
      track('tour_tab_selected', { tab: tab.textContent });
    });
    tab.addEventListener('keydown', (e) => {
      const next =
        e.key === 'ArrowRight'
          ? tabs[(i + 1) % tabs.length]
          : e.key === 'ArrowLeft'
            ? tabs[(i - 1 + tabs.length) % tabs.length]
            : e.key === 'Home'
              ? tabs[0]
              : e.key === 'End'
                ? tabs[tabs.length - 1]
                : null;
      if (next) {
        e.preventDefault();
        select(next, true);
      }
    });
  });
}

// The hero's SQL switch: the chart turns to glass and shows its query.
const seethrough = document.querySelector<HTMLElement>('[data-seethrough]');
if (seethrough) {
  const hotspot = seethrough.querySelector<HTMLButtonElement>('.sql-hotspot')!;
  const pane = seethrough.querySelector<HTMLElement>('.sql-glass')!;
  const close = seethrough.querySelector<HTMLButtonElement>('.sql-close')!;
  let touched = false;
  const set = (on: boolean) => {
    hotspot.setAttribute('aria-pressed', String(on));
    seethrough.classList.toggle('sql-on', on);
    pane.hidden = !on;
  };
  hotspot.addEventListener('click', () => {
    touched = true;
    set(hotspot.getAttribute('aria-pressed') !== 'true');
  });
  close.addEventListener('click', () => {
    touched = true;
    set(false);
    hotspot.focus();
  });
  // Show it once, after a moment, unless the visitor prefers less motion or got there first.
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          setTimeout(() => {
            if (!touched) set(true);
          }, 1800);
        }
      },
      { threshold: 0.15 },
    );
    io.observe(seethrough);
  }
}

export {};
