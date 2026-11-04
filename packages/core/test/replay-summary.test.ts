import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyseReplays } from '../src/replay-analysis.ts';
import {
  parseOffset,
  type RrwebEvent,
  snapshotAt,
  summariseReplay,
} from '../src/replay-summary.ts';

const T = 1_700_000_000_000;

// A minimal rrweb recording: a full snapshot with a button and an input, then interactions.
const snapshot = {
  type: 2,
  timestamp: T,
  data: {
    node: {
      id: 1,
      type: 0,
      childNodes: [
        {
          id: 2,
          type: 2,
          tagName: 'body',
          childNodes: [
            {
              id: 3,
              type: 2,
              tagName: 'button',
              attributes: { class: 'cta' },
              childNodes: [{ id: 4, type: 3, textContent: ' Pay now ' }],
            },
            { id: 5, type: 2, tagName: 'input', attributes: { placeholder: 'Email' } },
          ],
        },
      ],
    },
  },
};
const click = (ts: number, id: number) => ({
  type: 3,
  timestamp: T + ts,
  data: { source: 2, type: 2, id },
});
const input = (ts: number, id: number) => ({
  type: 3,
  timestamp: T + ts,
  data: { source: 5, id, text: '***' },
});

describe('replay summaries', () => {
  it('labels clicks, collapses typing and detects rage clicks', () => {
    const s = summariseReplay(
      [
        [
          snapshot,
          input(1000, 5),
          input(1200, 5),
          click(2000, 3),
          click(2300, 3),
          click(2600, 3),
          click(2900, 3),
        ],
      ],
      [
        { event: '$pageview', ts_ms: T, path: '/checkout', title: 'Checkout' },
        {
          event: '$exception',
          ts_ms: T + 3000,
          props: { type: 'TypeError', message: 'card is undefined' },
        },
      ],
      { sessionId: 's-1', person: 'alice' },
    );
    assert.equal(s.stats.clicks, 4);
    assert.equal(s.stats.rageClicks, 1);
    assert.equal(s.stats.inputs, 1);
    assert.equal(s.stats.errors, 1);
    assert.match(s.text, /00:00 Viewed \/checkout — "Checkout"/);
    assert.match(s.text, /00:01 Typed into "Email" \(input\)/);
    assert.match(s.text, /00:02 Rage-clicked "Pay now" \(button\) ×4/);
    assert.match(s.text, /00:03 ERROR TypeError: card is undefined/);
  });

  it('calls out long idle gaps', () => {
    const s = summariseReplay([[snapshot, click(1000, 3), click(60_000, 3)]]);
    assert.match(s.text, /no activity for 59s/);
  });

  it('reads each page load against its own DOM', () => {
    // rrweb restarts node ids on every page load, so id 3 is a different element on each page.
    // The pages overlap in time, as two tabs of one session do.
    const pricing = [
      page(0, el(3, 'button', {}, text(4, 'Choose Team'))),
      click(500, 3),
      click(800, 3),
      click(3000, 3),
    ];
    const signup = [
      page(
        1000,
        el(3, 'a', { href: '/' }, text(4, 'Home')),
        el(5, 'button', { type: 'submit' }, text(6, 'Create account')),
      ),
      click(1100, 3),
      click(2000, 5),
    ];
    const s = summariseReplay([pricing, signup]);
    const lines = s.text
      .split('\n')
      .filter((l) => l.includes('Clicked'))
      .map(plain);
    assert.deepEqual(lines, [
      '00:00 Clicked "Choose Team" (button) ×2',
      '00:01 Clicked "Home" (link)',
      '00:02 Clicked "Create account" (button)',
      '00:03 Clicked "Choose Team" (button)',
    ]);
    assert.equal(s.stats.rageClicks, 0);
  });

  it('names the control that was clicked, never script text or the whole page', () => {
    const recording = [
      page(
        0,
        el(3, 'button', { 'aria-label': 'Close' }, el(4, 'svg', {})),
        el(5, 'a', { href: '/' }, el(6, 'img', { alt: 'Inkwell' })),
        el(7, 'div', { role: 'button' }, el(8, 'span', {}, text(9, 'Upgrade'))),
        el(10, 'button', {}, el(11, 'svg', {})),
        el(
          12,
          'p',
          {},
          text(
            13,
            'A paragraph long enough that quoting all of it would make the transcript hard to read.',
          ),
        ),
        el(14, 'script', {}, text(15, "document.getElementById('signup')")),
      ),
      ...[4, 6, 8, 11, 13, 2].map((id, i) => click(1000 * (i + 1), id)),
    ];
    const clicked = summariseReplay([recording])
      .text.split('\n')
      .filter((l) => l.includes('Clicked'))
      .map((l) => plain(l).slice(6));
    assert.deepEqual(clicked, [
      'Clicked "Close" (button)',
      'Clicked "Inkwell" (link)',
      'Clicked "Upgrade" (button)',
      'Clicked a button',
      'Clicked "A paragraph long enough that quoting all of it would make t…" (p)',
      'Clicked the page background',
    ]);
  });

  it('handles recordings with hundreds of thousands of events', () => {
    const moves = Array.from({ length: 250_000 }, (_, i) => ({
      type: 3,
      timestamp: T + i,
      data: { source: 1, positions: [] },
    }));
    assert.equal(summariseReplay([[snapshot, ...moves]]).stats.durationSeconds, 250);
  });
});

/** A transcript line without its selector and signal annotations. */
const plain = (line: string) => line.replace(/ · .*$/, '').replace(/ \[.*\]$/, '');

describe('replay timelines', () => {
  const mutation = (ts: number, data: Record<string, unknown>) => ({
    type: 3,
    timestamp: T + ts,
    data: { source: 0, texts: [], attributes: [], removes: [], adds: [], ...data },
  });
  const custom = (ts: number, tag: string, payload: Record<string, unknown>) => ({
    type: 5,
    timestamp: T + ts,
    data: { tag, payload },
  });
  const end = (ts: number) => ({ type: 3, timestamp: T + ts, data: { source: 1, positions: [] } });

  it('labels elements added after the snapshot, one node at a time, as rrweb sends them', () => {
    // innerHTML = '<a href="/pricing">Start your free trial</a>': rrweb sends the <a> and its text as separate adds.
    const recording = [
      page(0, el(3, 'p', { id: 'cta' }, el(4, 'a', { href: '/pricing' }, text(5, 'See pricing')))),
      mutation(100, {
        removes: [{ parentId: 3, id: 4 }],
        adds: [
          {
            parentId: 20,
            nextId: null,
            node: { id: 21, type: 3, textContent: 'Start your free trial' },
          },
          {
            parentId: 3,
            nextId: null,
            node: {
              id: 20,
              type: 2,
              tagName: 'a',
              attributes: { href: '/pricing' },
              childNodes: [],
            },
          },
        ],
      }),
      click(500, 21),
      end(5000),
    ];
    const s = summariseReplay([recording]);
    assert.match(s.text, /00:00 Clicked "Start your free trial" \(link\) · #cta > a/);
  });

  it('follows text and attribute changes and removals', () => {
    const recording = [
      page(0, el(3, 'button', { class: 'save' }, text(4, 'Save'))),
      mutation(100, {
        texts: [{ id: 4, value: 'Saving…' }],
        attributes: [{ id: 3, attributes: { 'data-testid': 'save-btn' } }],
      }),
      click(200, 3),
      mutation(300, { removes: [{ parentId: 2, id: 3 }] }),
      click(400, 3),
      end(5000),
    ];
    const clicks = summariseReplay([recording]).timeline.filter((i) => i.kind === 'click');
    assert.equal(clicks[0]!.label, '"Saving…" (button)');
    assert.equal(clicks[0]!.selector, '[data-testid="save-btn"]');
    assert.equal(clicks[1]!.label, 'an element');
  });

  it('flags dead clicks and clicks followed by errors, and folds repeated events', () => {
    const recording = [
      page(
        0,
        el(3, 'button', { id: 'pay' }, text(4, 'Pay')),
        el(5, 'button', { id: 'open' }, text(6, 'Open menu')),
      ),
      click(1000, 3),
      click(3000, 5),
      mutation(3200, {
        adds: [
          {
            parentId: 2,
            nextId: null,
            node: {
              id: 7,
              type: 2,
              tagName: 'div',
              attributes: { role: 'dialog' },
              childNodes: [],
            },
          },
        ],
      }),
      end(9000),
    ];
    const s = summariseReplay(
      [recording],
      [
        { event: 'pay_clicked', ts_ms: T + 1000 },
        { event: 'pay_clicked', ts_ms: T + 1500 },
        {
          event: '$exception',
          ts_ms: T + 1100,
          props: {
            type: 'TypeError',
            message: 'x is undefined',
            stack:
              'TypeError: x is undefined\n    at pay (app.js:10:5)\n    at onClick (app.js:20:1)',
          },
        },
      ],
    );
    const [pay, open] = s.timeline.filter((i) => i.kind === 'click');
    assert.deepEqual(pay!.signals, ['dead', 'error']);
    assert.equal(open!.signals, undefined);
    assert.equal(s.stats.deadClicks, 1);
    assert.equal(s.stats.errorClicks, 1);
    assert.match(
      s.text,
      /00:01 Clicked "Pay" \(button\) · #pay \[dead click: nothing changed; an error followed\]/,
    );
    assert.match(s.text, /Event pay_clicked ×2/);
    assert.match(s.text, /ERROR TypeError: x is undefined\n {6}at pay \(app.js:10:5\)/);
  });

  it('reports failed and slow requests and console errors, hiding routine ones unless asked', () => {
    const recording = [
      page(0),
      custom(100, 'glass:network', {
        method: 'post',
        url: 'https://api.acme.com/pay?token=secret',
        status: 500,
        duration: 320,
      }),
      custom(200, 'glass:network', { method: 'GET', url: '/api/me', status: 200, duration: 40 }),
      custom(300, 'glass:network', {
        method: 'GET',
        url: '/api/report',
        status: 200,
        duration: 4200,
      }),
      custom(400, 'glass:console', { level: 'error', message: 'Payment failed' }),
      custom(500, 'glass:console', { level: 'log', message: 'debug noise' }),
    ];
    const s = summariseReplay([recording]);
    assert.match(s.text, /Request failed: POST https:\/\/api.acme.com\/pay → 500 \(320 ms\)/);
    assert.doesNotMatch(s.text, /token=secret/);
    assert.match(s.text, /Slow request: GET \/api\/report → 200 \(4.2 s\)/);
    assert.match(s.text, /Console error: Payment failed/);
    assert.doesNotMatch(s.text, /debug noise|\/api\/me/);
    assert.match(summariseReplay([recording], [], { detail: 'full' }).text, /debug noise/);
    assert.equal(s.stats.failedRequests, 1);
    assert.equal(s.stats.consoleErrors, 1);
  });

  it('places notes on the timeline', () => {
    const s = summariseReplay([[page(0), end(10_000)]], [], {
      notes: [{ ts: T + 5000, text: 'Button disabled here', author: 'agent' }],
    });
    assert.match(s.text, /00:05 Note \(agent\): Button disabled here/);
  });

  it('describes what was on screen at a moment', () => {
    const recording = [
      {
        type: 4,
        timestamp: T,
        data: { href: 'https://acme.com/signup', width: 1280, height: 800 },
      },
      page(
        0,
        el(3, 'h1', {}, text(4, 'Create your account')),
        el(5, 'input', { type: 'email', placeholder: 'Email' }),
        el(6, 'button', { disabled: '' }, text(7, 'Continue')),
        el(8, 'script', {}, text(9, 'secret()')),
        el(10, 'div', { style: 'display: none' }, text(11, 'Hidden promo')),
      ),
      { type: 3, timestamp: T + 1000, data: { source: 5, id: 5, text: '*****' } },
      mutation(2000, {
        adds: [
          {
            parentId: 2,
            nextId: null,
            node: {
              id: 12,
              type: 2,
              tagName: 'div',
              attributes: { role: 'alert' },
              childNodes: [{ id: 13, type: 3, textContent: 'Email already used' }],
            },
          },
        ],
      }),
    ];
    const before = snapshotAt([recording], T + 1500);
    assert.equal(before.url, 'https://acme.com/signup');
    assert.equal(before.viewport, '1280×800');
    assert.match(before.text, /# Create your account/);
    assert.match(before.text, /\[email "Email": \*\*\*\*\*\]/);
    assert.match(before.text, /\[button: Continue, disabled\]/);
    assert.doesNotMatch(before.text, /secret|Hidden promo|Email already used/);
    assert.match(snapshotAt([recording], T + 2500).text, /\[alert\]\nEmail already used/);
    // Before the recorder's first snapshot, show the first frame rather than nothing.
    assert.match(snapshotAt([recording], T - 500).text, /# Create your account/);
  });

  it('reads times as mm:ss or ms', () => {
    assert.equal(parseOffset('01:24'), 84_000);
    assert.equal(parseOffset('1:00:00'), 3_600_000);
    assert.equal(parseOffset(1500), 1500);
    assert.throws(() => parseOffset('soon'), /mm:ss/);
  });

  it('finds patterns across sessions', () => {
    const rage = (session: string, err: string) => ({
      session,
      ...summariseReplay(
        [
          [
            page(0, el(3, 'button', { id: 'pay' }, text(4, 'Pay'))),
            click(1000, 3),
            click(1200, 3),
            click(1400, 3),
            end(9000),
          ],
        ],
        [
          { event: '$pageview', ts_ms: T, path: '/checkout' },
          { event: '$exception', ts_ms: T + 1500, props: { type: 'TypeError', message: err } },
        ],
      ),
    });
    const a = analyseReplays([
      rage('s1', 'order 12345 failed'),
      rage('s2', 'order 67890 failed'),
      { session: 's3', ...summariseReplay([[page(0)]]) },
    ]);
    assert.equal(a.sessions, 3);
    assert.deepEqual(
      a.rageClicks.map((f) => [f.what, f.sessions, f.occurrences]),
      [['"Pay" (button) · #pay', 2, 6]],
    );
    assert.deepEqual(
      a.errors.map((f) => [f.what, f.sessions]),
      [['TypeError: order <n> failed', 2]],
    );
    assert.deepEqual(
      a.exitPages.map((f) => f.what),
      ['/checkout'],
    );
    const net = analyseReplays([
      {
        session: 's4',
        ...summariseReplay([
          [
            page(0),
            {
              type: 5,
              timestamp: T + 10,
              data: {
                tag: 'glass:network',
                payload: {
                  method: 'GET',
                  url: 'http://127.0.0.1:57190/api/orders/12345',
                  status: 404,
                  duration: 14,
                },
              },
            },
          ],
        ]),
      },
    ]);
    assert.deepEqual(
      net.failedRequests.map((f) => f.what),
      ['GET http://127.0.0.1:57190/api/orders/<id> → 404'],
    );
    assert.match(a.text, /Rage-clicked elements:\n- "Pay" \(button\) · #pay — 2 sessions, 6×/);
  });
});

type Node = {
  id: number;
  type: number;
  tagName?: string;
  attributes?: Record<string, string>;
  textContent?: string;
  childNodes?: Node[];
};

function el(
  id: number,
  tagName: string,
  attributes: Record<string, string>,
  ...childNodes: Node[]
): Node {
  return { id, type: 2, tagName, attributes, childNodes };
}

function text(id: number, textContent: string): Node {
  return { id, type: 3, textContent };
}

/** A full snapshot at T + ts of a document (id 1) whose body (id 2) holds `body`. */
function page(ts: number, ...body: Node[]): RrwebEvent {
  return {
    type: 2,
    timestamp: T + ts,
    data: { node: { id: 1, type: 0, childNodes: [el(2, 'body', {}, ...body)] } },
  };
}
