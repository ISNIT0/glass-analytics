/**
 * Session replays: a list, and a player beside the text transcript agents read.
 */

import { Replayer, type eventWithTime } from 'rrweb';
import 'rrweb/dist/style.css';
import { api } from '../api.ts';
import { copyButton, empty, errorState, later, loading, pageHeader, panel, table } from '../components/ui.ts';
import { h, mount } from '../dom.ts';
import { dateTime, duration } from '../format.ts';
import { type Route, go, href, scope } from '../state.ts';

interface ReplayListItem {
  session: string;
  person: string;
  started: string;
  durationSeconds: number;
  clicks: number;
  errors: number;
  url: string;
  device: string;
}

function list(route: Route): Node[] {
  const withErrors = route.params.get('errors') === '1';
  const toggle = h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: withErrors, onchange: () => go('replays', { errors: withErrors ? null : '1' }) }), 'Only sessions with errors');
  return [
    pageHeader('Replays', 'Recorded sessions. Each one has a text transcript that agents can read.', toggle),
    later(async () => {
      const r = await api.get<{ enabled: boolean; replays: ReplayListItem[] }>('/api/replays', { project: scope().project, with_errors: withErrors || undefined, limit: 100 });
      if (!r.enabled) return empty('Session replay is not enabled on this deployment. Enable R2 in your Cloudflare account, then run glass upgrade.');
      if (r.replays.length === 0) {
        return empty(
          withErrors ? 'No recorded sessions with errors.' : 'No recordings yet. Set data-replay-sample-rate="0.1" on the script tag to record 10% of sessions.',
        );
      }
      return table(
        ['Started', 'Person', 'Length', 'Clicks', 'Errors', 'First page', 'Device'],
        r.replays.map((x) => [
          h('a', { href: href(`replays/${x.session}`) }, dateTime(x.started)),
          h('a', { href: href(`users/${encodeURIComponent(x.person)}`) }, x.person.slice(0, 16)),
          duration(x.durationSeconds),
          String(x.clicks),
          x.errors ? h('span', { class: 'badge bad' }, String(x.errors)) : '0',
          h('span', { class: 'muted' }, x.url.replace(/^https?:\/\//, '')),
          h('span', { class: 'muted' }, x.device),
        ]),
        { numeric: [3, 4] },
      );
    }),
  ];
}

/** rrweb needs the player root in the document before it builds its sandboxed iframe. */
async function whenConnected(el: Element): Promise<void> {
  if (el.isConnected) return;
  await new Promise<void>((resolve) => {
    const tick = () => {
      if (el.isConnected) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function detail(session: string): Node[] {
  const project = scope().project;
  // Mount the stage up front so Replayer can create its sandboxed iframe.
  const stage = h('div', { class: 'replay-stage' });
  const controls = h('div', { class: 'player-bar' }, loading('Loading recording'));
  let replayer: Replayer | null = null;

  void (async () => {
    try {
      const r = await api.get<{ events: eventWithTime[] }>(`/api/replays/${encodeURIComponent(session)}/events`, { project });
      if (r.events.length < 2) {
        mount(controls, empty('This recording has no playable events yet.'));
        return;
      }
      await whenConnected(stage);
      stage.replaceChildren();
      replayer = new Replayer(r.events, { root: stage, skipInactive: true, showWarning: false });
      const meta = replayer.getMetaData();
      let playing = false;
      const button = h('button', { type: 'button', class: 'primary' }, 'Play');
      button.addEventListener('click', () => {
        if (!replayer) return;
        if (playing) replayer.pause();
        else replayer.play();
        playing = !playing;
        button.textContent = playing ? 'Pause' : 'Play';
      });
      mount(controls, button, h('span', { class: 'muted' }, duration(meta.totalTime / 1000)));
    } catch (err) {
      mount(controls, errorState(err));
    }
  })();

  // Tear down the player if the user navigates away before it finishes.
  const cleanup = () => {
    window.removeEventListener('hashchange', cleanup);
    try {
      replayer?.pause();
    } catch {
      // ignore
    }
    replayer = null;
  };
  window.addEventListener('hashchange', cleanup, { once: true });

  return [
    pageHeader('Replay', `Session ${session}`, copyButton(`Using the Glass MCP tool summarise_replay, read session ${session} and tell me what went wrong.`, 'Copy as agent prompt')),
    h(
      'div',
      { class: 'replay-layout' },
      panel('Recording', [stage, controls], { class: 'player' }),
      panel(
        'Transcript',
        later(async () => {
          const r = await api.get<{ transcript: string }>(`/api/replays/${encodeURIComponent(session)}/summary`, { project });
          return h('pre', { class: 'transcript' }, r.transcript);
        }, 'Reading the session'),
      ),
    ),
  ];
}

export function replaysPage(route: Route): Node[] {
  return route.rest[0] ? detail(route.rest[0]) : list(route);
}
