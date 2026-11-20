/** The Inbox drawn with the real kit, as markup: what the mocked tests beside this cannot see. */
import { expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InboxQuestionCard, InboxView } from './index';
import type { InboxItem, InboxSnapshot } from './model';
const item: InboxItem = { id: 'in-pump', source: 'thread', agent: 'art', project: 'pond', at: '2026-11-14T15:20:00Z', state: 'waiting', volume: 'full', answers: 'yes-no', read: false, refs: ['t-2190', 'github:owner/repo#12'], canSetVolume: true,
  body: { words: 'Spend up to $180 on the pump Art picked?', why: 'The pump is in stock today.', ifYes: 'Art orders it today.', ifNo: 'Art looks for a cheaper one.' } };
const folders = { needs: 2, alerts: 0, answered: 5, fyi: 0, all: 7, agents: [{ id: 'art', count: 2 }] };
const snapshot: InboxSnapshot = { status: 'live', folders, items: [item, { ...item, id: 'bare', source: 'notice', body: { words: 'Clock stopped' } }] };
const navigation = { folder: 'needs', query: '', offset: 0, hasNext: false, onFolder: vi.fn(), onQuery: vi.fn(), previous: vi.fn(), next: vi.fn() };
const view = (extra: object = {}) => renderToStaticMarkup(h(InboxView, { snapshot, select: vi.fn(), navigation: { ...navigation, ...extra } }));

it('says the folder and its count over the list, searches from a compact field, and pages only when there is another page', () => {
  const html = view();
  expect(html).toMatch(/<h2>Needs you<\/h2><span class="loom-split__list-count">2<\/span>/);
  expect(html).toContain('placeholder="Search asks"'); expect(html).toContain('aria-label="Search asks"');
  expect(html).not.toContain('Previous page'); expect(html).not.toContain('Next page');
  expect(html).toContain('art · open · Unread'); expect(html).not.toContain('>notice<'); expect(html).not.toContain('waiting');
  expect(view({ hasNext: true })).toContain('Next page'); expect(view({ offset: 50 })).toContain('Previous page');
});
it('draws the reader as the site does: one filled button, quiet ones in rows, facts with labels, references as chips', () => {
  const html = renderToStaticMarkup(h(InboxQuestionCard, { id: item.id, snapshot, zone: 'America/Chicago', actions: { answer: async () => {}, volume: async () => {}, openRef: ref => ref.startsWith('t-') ? () => {} : undefined } }));
  expect(html).toContain('<p class="loom-reader__meta ">art · open</p><h2 class="loom-reader__title ">Spend up to $180 on the pump Art picked?</h2>');
  expect(html).toContain('Nov 14, 2026, 9:20 AM</time> · pond');
  expect(html.match(/<dt class="loom-reader__label">([^<]+)</g)).toEqual(['Why', 'If yes', 'If no', 'About'].map(label => `<dt class="loom-reader__label">${label}<`));
  expect(html).toContain('<button type="button" class="loom-kit-chip" aria-label="Open t-2190">t-2190</button><span class="loom-kit-chip">github:owner/repo#12</span>');
  expect(html.match(/ -primary /g)).toHaveLength(1);
  expect(html.match(/<button[^>]*data-slot="button"/g)).toHaveLength(5);
  expect(html).toContain('placeholder="Or answer in your own words"');
  expect(html).toContain('aria-label="Notify"'); expect(html).not.toContain('Volume'); expect(html).not.toContain('America/Chicago');
});
