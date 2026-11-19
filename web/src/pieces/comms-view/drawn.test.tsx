/** Comms drawn with the real kit, as markup: what the mocked tests beside this cannot see. */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommsView, WorkPanel, WorkCard } from './index';
import { List, Row } from '../../kit';
import { chipped } from './prose';
import { prose } from '../../../../src/ui/prose';
import type { CommsDetail, CommsSnapshot } from './model';
afterEach(() => { vi.useRealTimers(); });
const thread = { id: 'th:pump', conversation: 'cv-pump', title: 'Pond pump', agent: 'art', project: 'pond', member: 'alice', pinned: false, lastAt: '2026-11-14T20:00:00Z', readSeq: 0, working: false, stopRequested: false };
const snapshot: CommsSnapshot = { status: 'live', member: 'alice', folders: { threads: 3, archived: 1 }, agents: [{ id: 'art', name: 'Art' }],
  threads: [thread, { ...thread, id: 'th:dates', title: 'Electrician dates', unread: true }, { ...thread, id: 'th:shop', title: 'Weekly shop', agent: 'mark', project: null, pinned: true }], names: { mark: 'Mark' } };
const detail: CommsDetail = { status: 'live', thread, refs: [{ ref: 't-2190', messageSeq: 3 }], messages: [
  { thread: thread.id, seq: 1, kind: 'message', sender: 'alice', at: '2026-11-14T20:00:00Z', words: 'Can you find a pump that fits the old hose?', delivery: 'delivered' },
  { thread: thread.id, seq: 2, kind: 'card', sender: 'art', at: '2026-11-14T20:01:00Z', words: 'Looked up three pumps', tool: 'web_search', cardState: 'done' },
  { thread: thread.id, seq: 3, kind: 'reply', sender: 'art', at: '2026-11-14T20:02:00Z', words: 'Three fit. I filed t-2190 to order it.' },
] };
const actions = { open: async () => {}, send: async () => {}, read: async () => {}, change: async () => {} };
const navigation = { archived: false, search: '', offset: 0, hasNext: false, folder: vi.fn(), query: vi.fn(), previous: vi.fn(), next: vi.fn() };
const view = (extra: object = {}, more: object = {}) => renderToStaticMarkup(h(CommsView, { snapshot, detail, selected: thread.id, select: vi.fn(), actions, zone: 'America/Chicago', navigation: { ...navigation, ...extra }, ...more }));

it('heads the list with the folder, its count and New, searches from a compact field, and pages only when there is another page', () => {
  const html = view();
  expect(html).toMatch(/<h2>Threads<\/h2><span class="loom-split__list-count">3<\/span><span class="loom-split__list-action"><button[^>]*aria-label="New conversation with Art"[^>]*>/);
  expect(html).toContain('placeholder="Search conversations"'); expect(html).toContain('aria-label="Search conversations"');
  expect(html).not.toContain('Previous page'); expect(html).not.toContain('Next page'); expect(html).not.toContain('<details'); expect(html).not.toContain('<summary');
  expect(view({ hasNext: true })).toContain('Next page'); expect(view({ offset: 50 })).toContain('Previous page');
  expect(view({ archived: true })).toMatch(/<h2>Archived<\/h2><span class="loom-split__list-count">1<\/span>/);
  // A row: the agent's initial, its display name and project; a status only when it says something; a dot when unread.
  expect(html).not.toContain('Ready'); expect(html.match(/class="loom-kit-status"/g)).toHaveLength(1); expect(html).toContain('<span class="loom-kit-status">Pinned</span>');
  expect(html.match(/data-unread="true"/g)).toHaveLength(1); expect(html).toContain('<span class="loom-kit-dot" aria-label="Unread"></span>');
  expect(html).toContain('<span class="comms-letter" aria-hidden="true">M</span>'); expect(html).toContain('<span class="loom-kit-meta">Mark</span>'); expect(html).toContain('<span class="loom-kit-meta">Art · pond</span>');
});
it('draws the open thread as the site does: a head built from the kit, bubbles, a dashed step line, one filled button', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-14T22:00:00Z'));
  const html = view({}, { cards: { screen: h('span', { className: 'face' }) } });
  expect(html).toContain('<header class="loom-reader__head "><span class="face"></span><div class="loom-reader__head-words"><h2 class="loom-reader__title ">Pond pump</h2><p class="loom-reader__meta ">with Art <span class="loom-kit-chip">pond</span></p></div>');
  // Stop is not offered (nothing is running); More is the one control in the head, closed.
  expect(html).toMatch(/<\/div><div class="loom-kit-actions "><span class="loom-kit-menu"><button[^>]*aria-expanded="false"[^>]*>/);
  for (const hidden of ['>Pin<', '>Archive<', '>Rename<', '>Delete<', '>Stop<']) expect(html).not.toContain(hidden);
  expect(html).toContain('<li class="comms-group" data-side="me"><p class="comms-group__who" aria-hidden="true"><span>You</span><time dateTime="2026-11-14T20:00:00Z" title="Nov 14, 2026, 2:00 PM">2:00 PM</time></p>');
  expect(html).toContain('<p class="comms-bubble" data-plain="">Can you find a pump that fits the old hose?</p>');
  expect(html).toContain('<li class="comms-step" data-state="done"><span class="comms-sr">Art, Nov 14, 2026, 2:01 PM: </span><span>Looked up three pumps · done</span></li>');
  expect(html).toContain('<li class="comms-group" data-side="them">');
  expect(html.match(/ -primary /g)).toHaveLength(1);
  expect(html).toMatch(/<textarea[^>]*rows="1"[^>]*aria-label="Message Art"[^>]*placeholder="Message Art"/);
  expect(html).toContain('<p role="status" class="loom-composer__status"></p>');
  for (const raw of ['America/Chicago', ' CT<', 'web_search', '· delivered', '>message<', '>card<']) expect(html).not.toContain(raw);
});
it('draws a reply as markdown that cannot carry markup, a script or an unsafe link, with its references as chips', () => {
  const unsafe = prose('**Bold** <script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](data:text/html,x) ![i](https://example.test/i.png) [ok](https://example.test/a?b=1&c=2)');
  expect(unsafe).toContain('<strong>Bold</strong>'); expect(unsafe).toContain('&lt;script&gt;'); expect(unsafe).toContain('&lt;img');
  for (const live of ['<script', '<img', 'href="javascript:', 'href="data:', 'onerror="']) expect(unsafe).not.toContain(live);
  expect(unsafe).toContain('<a href="https://example.test/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">ok</a>');
  // Chips go into the words only: never into a tag, a link's words or code, and only for a plain id.
  const html = chipped(prose('I filed t-2190 and `t-2190` and [t-2190](https://example.test/t-2190), also github:owner/repo#12; not at-21900.'), ['t-2190', 'github:owner/repo#12', '<b>'], ref => ref === 't-2190');
  expect(html).toContain('I filed <button type="button" class="loom-kit-chip" data-ref="t-2190" aria-label="Open t-2190">t-2190</button> and <code>t-2190</code> and <a href="https://example.test/t-2190" rel="noopener noreferrer" target="_blank">t-2190</a>');
  expect(html).toContain('<span class="loom-kit-chip">github:owner/repo#12</span>'); expect(html).toContain('not at-21900.');
  expect(html.match(/loom-kit-chip/g)).toHaveLength(2);
});
it('draws Work as the kit\'s quiet rows under one heading, with a closed "Work · 3" line for a narrow reader', () => {
  const html = renderToStaticMarkup(h(WorkPanel, { count: 3 }, h(List, { label: 'Tasks in this conversation' }, h(Row, { title: 'Order the pump', status: 't-2190 · open · Made here' })),
    h(WorkCard, { label: 'Conversation change github:owner/repo#12', made: true }, h('article', null, 'card'))));
  expect(html).toMatch(/^<section class="comms-work" aria-label="Work in this conversation"><h3 class="loom-reader__label comms-work__label">Work<\/h3><button type="button" class="comms-work__toggle" aria-expanded="false" aria-controls="[^"]+">Work · 3<\/button>/);
  expect(html).toContain('<span class="loom-kit-title">Order the pump</span><span class="loom-kit-status">t-2190 · open · Made here</span>');
  expect(html).toContain('<div class="loom-kit-refc" role="group" aria-label="Conversation change github:owner/repo#12"><p class="loom-kit-refc__note">Made here</p><article>card</article></div>');
});
