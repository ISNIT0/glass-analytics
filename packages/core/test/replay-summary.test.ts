import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type RrwebEvent, summariseReplay } from '../src/replay-summary.ts';

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
            { id: 3, type: 2, tagName: 'button', attributes: { class: 'cta' }, childNodes: [{ id: 4, type: 3, textContent: ' Pay now ' }] },
            { id: 5, type: 2, tagName: 'input', attributes: { placeholder: 'Email' } },
          ],
        },
      ],
    },
  },
};
const click = (ts: number, id: number) => ({ type: 3, timestamp: T + ts, data: { source: 2, type: 2, id } });
const input = (ts: number, id: number) => ({ type: 3, timestamp: T + ts, data: { source: 5, id, text: '***' } });

describe('replay summaries', () => {
  it('labels clicks, collapses typing and detects rage clicks', () => {
    const s = summariseReplay(
      [[snapshot, input(1000, 5), input(1200, 5), click(2000, 3), click(2300, 3), click(2600, 3), click(2900, 3)]],
      [
        { event: '$pageview', ts_ms: T, path: '/checkout', title: 'Checkout' },
        { event: '$exception', ts_ms: T + 3000, props: { type: 'TypeError', message: 'card is undefined' } },
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
    const pricing = [page(0, el(3, 'button', {}, text(4, 'Choose Team'))), click(500, 3), click(800, 3), click(3000, 3)];
    const signup = [page(1000, el(3, 'a', { href: '/' }, text(4, 'Home')), el(5, 'button', { type: 'submit' }, text(6, 'Create account'))), click(1100, 3), click(2000, 5)];
    const s = summariseReplay([pricing, signup]);
    const lines = s.text.split('\n').filter((l) => l.includes('Clicked'));
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
        el(12, 'p', {}, text(13, 'A paragraph long enough that quoting all of it would make the transcript hard to read.')),
        el(14, 'script', {}, text(15, "document.getElementById('signup')")),
      ),
      ...[4, 6, 8, 11, 13, 2].map((id, i) => click(1000 * (i + 1), id)),
    ];
    const clicked = summariseReplay([recording]).text.split('\n').filter((l) => l.includes('Clicked')).map((l) => l.slice(6));
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
    const moves = Array.from({ length: 250_000 }, (_, i) => ({ type: 3, timestamp: T + i, data: { source: 1, positions: [] } }));
    assert.equal(summariseReplay([[snapshot, ...moves]]).stats.durationSeconds, 250);
  });
});

type Node = { id: number; type: number; tagName?: string; attributes?: Record<string, string>; textContent?: string; childNodes?: Node[] };

function el(id: number, tagName: string, attributes: Record<string, string>, ...childNodes: Node[]): Node {
  return { id, type: 2, tagName, attributes, childNodes };
}

function text(id: number, textContent: string): Node {
  return { id, type: 3, textContent };
}

/** A full snapshot at T + ts of a document (id 1) whose body (id 2) holds `body`. */
function page(ts: number, ...body: Node[]): RrwebEvent {
  return { type: 2, timestamp: T + ts, data: { node: { id: 1, type: 0, childNodes: [el(2, 'body', {}, ...body)] } } };
}
