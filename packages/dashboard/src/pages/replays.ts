/**
 * Session replays: a list, and a player beside the text transcript agents read.
 */

import { Replayer, type eventWithTime } from 'rrweb';
import 'rrweb/dist/style.css';
import { api } from '../api.ts';
import { icon } from '../components/icons.ts';
import { toggle } from '../components/menu.ts';
import { copyButton, empty, errorState, later, loading, pageHeader, panel, table, tabs } from '../components/ui.ts';
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
  const errorsOnly = toggle({ checked: withErrors, label: 'Only sessions with errors', onChange: () => go('replays', { errors: withErrors ? null : '1' }) });
  return [
    pageHeader('Replays', 'Recorded sessions. Each one has a text transcript that agents can read.', errorsOnly),
    later(async () => {
      const r = await api.get<{ enabled: boolean; replays: ReplayListItem[] }>('/api/replays', { project: scope().project, with_errors: withErrors || undefined, limit: 100 });
      if (!r.enabled) return empty('Enable R2 in your Cloudflare account, then run glass upgrade.', undefined, { icon: 'replay', title: 'Session replay is off' });
      if (r.replays.length === 0) {
        return withErrors
          ? empty('No recorded sessions hit an error in this period.', undefined, { icon: 'check', title: 'No errors' })
          : empty('Set data-replay-sample-rate="0.1" on the script tag to record 10% of sessions. Inputs are masked.', h('a', { class: 'button', href: href('settings') }, icon('code', 14), 'Install snippet'), { icon: 'replay', title: 'No recordings yet' });
      }
      return panel(`${r.replays.length} recordings`, table(
        ['Started', 'Person', 'Length', 'Clicks', 'Errors', 'First page', 'Device'],
        r.replays.map((x) => [
          h('a', { class: 'replay-link', href: href(`replays/${x.session}`) }, h('span', { class: 'play-chip' }, icon('play', 11)), dateTime(x.started)),
          h('a', { href: href(`users/${encodeURIComponent(x.person)}`) }, x.person.slice(0, 16)),
          duration(x.durationSeconds),
          String(x.clicks),
          x.errors ? h('span', { class: 'badge bad' }, icon('alert', 12), String(x.errors)) : h('span', { class: 'muted' }, '0'),
          h('span', { class: 'muted cell-clip' }, x.url.replace(/^https?:\/\//, '')),
          h('span', { class: 'muted device-cell' }, icon(x.device === 'mobile' ? 'smartphone' : x.device === 'tablet' ? 'tablet' : 'monitor', 14), x.device),
        ]),
        { numeric: [3, 4] },
      ), { icon: 'replay', class: 'flush' });
    }, 'Loading recordings', 'table'),
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
      let speed = '1';
      const button = h('button', { type: 'button', class: 'primary' }, icon('play', 14), 'Play');
      button.addEventListener('click', () => {
        if (!replayer) return;
        if (playing) replayer.pause();
        else replayer.play();
        playing = !playing;
        mount(button, icon(playing ? 'pause' : 'play', 14), playing ? 'Pause' : 'Play');
      });
      const speeds = () =>
        tabs(
          [
            { value: '1', label: '1×' },
            { value: '2', label: '2×' },
            { value: '4', label: '4×' },
          ],
          speed,
          (v) => {
            speed = v;
            replayer?.setConfig({ speed: Number(v) });
            mount(speedSlot, speeds());
          },
          'tabs-small',
        );
      const speedSlot = h('span', {}, speeds());
      mount(controls, button, speedSlot, h('span', { class: 'muted' }, icon('clock', 14), ' ', duration(meta.totalTime / 1000)));
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
      panel('Recording', [stage, controls], { class: 'player', icon: 'replay' }),
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
