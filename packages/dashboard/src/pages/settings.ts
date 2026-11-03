/**
 * Settings (install snippets, agent setup, projects) and the key screen.
 */

import { api } from '../api.ts';
import { copyButton, errorState, later, pageHeader, panel, table, toast } from '../components/ui.ts';
import { h, mount } from '../dom.ts';
import { dateTime } from '../format.ts';
import { config, prefs, scope } from '../state.ts';

const workerUrl = () => `${location.origin}${config.base}`;

function codeBlock(code: string): HTMLElement {
  return h('div', { class: 'code-block' }, h('pre', {}, h('code', {}, code)), copyButton(code));
}

export function settingsPage(): Node[] {
  const project = scope().project ?? 'your-project';
  const host = workerUrl();
  return [
    pageHeader('Settings', 'Install Glass on a site, connect an agent, manage projects.'),
    h(
      'div',
      { class: 'grid-2' },
      panel(
        'Install on a site',
        [
          h('p', {}, 'Add this to the <head> of every page. Pageviews, clicks, errors and web vitals are captured automatically.'),
          codeBlock(`<script defer src="${host}/s.js" data-project="${project}"></script>`),
          h('p', {}, 'Then track what matters:'),
          codeBlock(`glass.capture('signup_completed', { plan: 'pro' });\nglass.identify(user.id, { plan: user.plan });`),
        ],
      ),
      panel(
        'Connect an agent',
        [
          h('p', {}, 'In a project set up with glass init, agents already have the MCP server. Elsewhere, add it by URL with your key:'),
          codeBlock(`claude mcp add --transport http glass ${host}/mcp \\\n  --header "Authorization: Bearer $GLASS_API_KEY"`),
          h('p', {}, 'Agent instructions for this deployment:'),
          codeBlock(`${host}/llms.txt`),
        ],
      ),
    ),
    later(async () => {
      const [health, projects] = await Promise.all([
        api.get<{ version: string; store: string; replay: boolean; freshnessSeconds: number }>('/health'),
        api.get<{ projects: { id: string; name: string; createdAt: number; allowedOrigins: string[] }[] }>('/api/projects'),
      ]);
      const id = h('input', { type: 'text', required: true, placeholder: 'acme-docs', pattern: '[a-z0-9][a-z0-9_-]*' });
      const error = h('div', {});
      const form = h('form', { class: 'inline-form' }, id, h('button', { type: 'submit', class: 'ghost' }, 'Add project'), error);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api.post('/api/projects', { id: id.value });
          toast(`Project ${id.value} added`);
          location.reload();
        } catch (err) {
          mount(error, errorState(err));
        }
      });
      return h(
        'div',
        { class: 'grid-2' },
        panel('Projects', [
          table(
            ['Project', 'Created', 'Allowed origins'],
            projects.projects.map((p) => [h('code', {}, p.id), dateTime(p.createdAt), p.allowedOrigins.join(', ') || h('span', { class: 'muted' }, 'Any')]),
          ),
          form,
        ]),
        panel(
          'This deployment',
          h(
            'dl',
            { class: 'props' },
            h('dt', {}, 'Version'),
            h('dd', {}, health.version),
            h('dt', {}, 'Event store'),
            h('dd', {}, health.store === 'lake' ? `Iceberg lake (data appears after about ${Math.round(health.freshnessSeconds / 60)} min)` : 'D1 (real time)'),
            h('dt', {}, 'Session replay'),
            h('dd', {}, health.replay ? 'Enabled' : 'Disabled (no R2 bucket)'),
            h('dt', {}, 'Signed in with'),
            h('dd', {}, h('button', { type: 'button', class: 'ghost small', onclick: () => { prefs.key = null; location.reload(); } }, 'Forget this key')),
          ),
        ),
      );
    }),
  ];
}

export function keyScreen(onDone: () => void): HTMLElement {
  const input = h('input', { type: 'password', required: true, autocomplete: 'off', placeholder: 'Paste your Glass API key', 'aria-label': 'API key' });
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack' },
    input,
    error,
    h('button', { type: 'submit', class: 'primary' }, 'Open dashboard'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    prefs.key = input.value.trim();
    try {
      await api.get('/api');
      onDone();
    } catch (err) {
      prefs.key = null;
      mount(error, errorState(err));
    }
  });
  return h(
    'main',
    { class: 'key-screen' },
    h('h1', {}, 'Glass'),
    h('p', {}, 'Paste the API key created by glass init. Run ', h('code', {}, 'npx glass key'), ' in your project to print it.'),
    form,
    h('p', { class: 'muted small' }, 'The key stays in this browser. Use the read-only key to share the dashboard without letting people change flags.'),
  );
}
