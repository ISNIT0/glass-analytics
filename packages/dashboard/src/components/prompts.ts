/**
 * Copyable prompts for a coding agent. Dataflare is built to be driven by an agent
 * with the Dataflare MCP server; these cards turn "what should I ask it?" into one
 * click. Each set can be hidden, and stays hidden in this browser.
 */

import { h } from '../dom.ts';
import { type IconName, icon } from './icons.ts';
import { copyButton } from './ui.ts';

export interface AgentPrompt {
  title: string;
  prompt: string;
  icon: IconName;
}

const HIDDEN_KEY = 'glass:hidden-prompts';

function hidden(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function hide(id: string): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden(), id]));
  } catch {
    // Storage blocked: hidden for this page view only.
  }
}

/** A row of prompt cards with a copy button each. `id` remembers whether the row was hidden. */
export function promptStrip(id: string, title: string, prompts: AgentPrompt[]): HTMLElement | null {
  if (hidden().has(id)) return null;
  const el = h(
    'section',
    { class: 'prompt-strip', 'aria-label': title },
    h(
      'header',
      {},
      h('span', { class: 'prompt-strip-title' }, icon('bot', 15), title),
      h(
        'button',
        {
          type: 'button',
          class: 'ghost small',
          onclick: () => {
            hide(id);
            el.remove();
          },
        },
        'Hide',
      ),
    ),
    h(
      'div',
      { class: 'prompt-cards' },
      prompts.map((p) =>
        h(
          'div',
          { class: 'prompt-card' },
          h('span', { class: 'prompt-icon' }, icon(p.icon, 16)),
          h(
            'div',
            { class: 'prompt-body' },
            h('strong', {}, p.title),
            h('p', { class: 'muted' }, p.prompt),
          ),
          copyButton(p.prompt, 'Copy prompt'),
        ),
      ),
    ),
  );
  return el;
}

const GLASS = 'Use the Dataflare MCP tools';

export const HOME_PROMPTS: AgentPrompt[] = [
  {
    title: 'Fix the top errors',
    icon: 'alert',
    prompt: `${GLASS}: run site_health for the last 30 days, take the 3 most frequent JavaScript errors, read a replay of each with list_replays (has: ["errors"]) and summarise_replay, find the cause in this codebase and fix them. Tell me what each fix changes.`,
  },
  {
    title: 'Find conversion drop-offs',
    icon: 'funnel',
    prompt: `${GLASS}: list the key events (list_events) and build the main conversion funnel from landing to the conversion event with query_funnel, broken down by device and channel. Find the biggest drop-off, watch sessions that dropped there (list_replays with did_event / not_event), and propose concrete changes to the page or flow. Save the funnel with save_insight.`,
  },
  {
    title: 'Mark what success looks like',
    icon: 'flag',
    prompt: `${GLASS}: run list_events and read this codebase to work out which events mean a visitor succeeded (signup, purchase, pledge, lead). Mark them with mark_event role "conversion", and mark useful engagement events "important". If the site doesn't track its conversions yet, add the tracking (instrument tells you the code), deploy, then mark them.`,
  },
  {
    title: 'What is frustrating people?',
    icon: 'replay',
    prompt: `${GLASS}: run analyse_replays for the last 14 days. For the top rage-clicked and dead-clicked elements, open an example (summarise_replay, replay_snapshot), find the element in this codebase by its selector, and fix what makes people click it repeatedly.`,
  },
  {
    title: 'Weekly report',
    icon: 'reports',
    prompt: `${GLASS}: run overview for the last 7 days vs the week before, query_sources by channel and campaign, and site_health. Write me a short weekly report: what changed, which sources converted best, what broke, and the 3 things worth doing next.`,
  },
];

export const MARKETING_PROMPTS: AgentPrompt[] = [
  {
    title: 'Which campaigns work?',
    icon: 'megaphone',
    prompt: `${GLASS}: run query_sources with dimension "utm_campaign" and then "channel" for the last 30 days. Rank campaigns by conversion rate and by converting visitors, flag any with high bounce and few conversions, and tell me where to move budget.`,
  },
  {
    title: 'Tag links that are missing UTMs',
    icon: 'link',
    prompt: `${GLASS}: run query_sources by "referrer" and "channel". For big referrers with no UTM tags (social posts, newsletters, partners), suggest a consistent utm_source / utm_medium / utm_campaign scheme and list the links we should retag.`,
  },
  {
    title: 'Improve the top landing pages',
    icon: 'external',
    prompt: `${GLASS}: run query_sources with dimension "entry_page". For the 3 landing pages with the most visitors and the lowest conversion rate, read a few replays (list_replays with url) and propose copy or layout changes in this codebase.`,
  },
];

export const HEALTH_PROMPTS: AgentPrompt[] = [
  {
    title: 'Fix the top errors',
    icon: 'alert',
    prompt: HOME_PROMPTS[0]!.prompt,
  },
  {
    title: 'Fix broken pages',
    icon: 'link',
    prompt: `${GLASS}: run site_health and look at the pages that look like "not found" pages and where their visitors came from. Find the broken links in this codebase (or add redirects for old URLs) and fix them.`,
  },
  {
    title: 'Speed up the slowest pages',
    icon: 'gauge',
    prompt: `${GLASS}: run site_health and query_web, and look at web vitals and the slowest pages by LCP. Profile the worst page in this codebase (images, fonts, blocking scripts, data fetching) and make it load faster. Tell me the expected effect on LCP.`,
  },
];

export const INSIGHT_PROMPT = `${GLASS} to build the analyses this product needs. First run list_events and list_insights, and read this codebase to understand what the product does and which events mean success. Then create and save (save_insight) a small set of analyses: the main conversion funnel, weekly active users, retention of new visitors, and trends of the key events broken down by channel or campaign. Document undocumented events with define_event and mark conversions with mark_event. If an event we need isn't tracked yet, add it (instrument shows the code) and tell me.`;
