/** The boards page's tab title: the thread's title or "Loom", and a mark while the tab is hidden and a reply is
 * unread. The test renderer, with the data hook and the document faked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';

const f = vi.hoisted(() => {
  const f = { answer: { status: 'live', data: null } as { status: string; data?: unknown }, asked: [] as unknown[], heard: [] as [string, () => void][] };
  (globalThis as Record<string, any>).document = {
    title: 'Loom', visibilityState: 'visible',
    addEventListener: (name: string, fn: () => void) => { f.heard.push([name, fn]); },
    removeEventListener: (name: string, fn: () => void) => { f.heard = f.heard.filter(([n, one]) => n !== name || one !== fn); },
  };
  return f;
});
vi.mock('../data/graphql', () => ({ useDataQuery: (query: string, variables: unknown) => { f.asked.push([/query (\w+)/.exec(query)![1], variables]); return f.answer; } }));
vi.mock('../data/operation', () => ({ memberOperation: vi.fn() }));
import { UNREAD_MARK, pageTitle, usePageTitle } from './title';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const doc = document as unknown as { title: string; visibilityState: string };
function Probe({ thread, unread }: { thread: string; unread: boolean }) { usePageTitle(thread, unread); return null; }
let tree: { update(element: unknown): void; unmount(): void } | undefined;
const draw = (thread: string, unread: boolean) => act(async () => { const el = h(Probe, { thread, unread }); if (tree) tree.update(el); else tree = create(el); });
const see = (state: 'visible' | 'hidden') => act(async () => { doc.visibilityState = state; for (const [name, fn] of [...f.heard]) if (name === 'visibilitychange') fn(); });
const titled = (id: string, title: string) => ({ status: 'live', data: { thread: { id, title } } });

beforeEach(() => { f.answer = { status: 'live', data: null }; f.asked = []; f.heard = []; doc.title = 'Loom'; doc.visibilityState = 'visible'; });
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; });

describe('the words of the title', () => {
  it('is the thread\'s title, or Loom, with the mark in front when marked', () => {
    expect(pageTitle('The pond', false)).toBe('The pond');
    expect(pageTitle('The pond', true)).toBe(UNREAD_MARK + 'The pond');
    for (const none of [undefined, null, '', '   ']) expect(pageTitle(none, false)).toBe('Loom');
    expect(pageTitle(undefined, true)).toBe(UNREAD_MARK + 'Loom');
  });
});

describe('the tab\'s title on the boards page', () => {
  it('is Loom until the thread is read, then the thread\'s title, by the thread head\'s own read', async () => {
    f.answer = { status: 'loading' };
    await draw('th:pond', false);
    expect(doc.title).toBe('Loom');
    expect(f.asked[0]).toEqual(['BoardsThreadHead', { id: 'th:pond' }]);
    f.answer = titled('th:pond', 'The pond');
    await draw('th:pond', false);
    expect(doc.title).toBe('The pond');
  });
  it('never shows another thread\'s title while the new thread is being read', async () => {
    f.answer = titled('th:pond', 'The pond');
    await draw('th:gate', false);
    expect(doc.title).toBe('Loom');
  });
  it('follows a rename', async () => {
    f.answer = titled('th:pond', 'The pond'); await draw('th:pond', false);
    f.answer = titled('th:pond', 'The pump'); await draw('th:pond', false);
    expect(doc.title).toBe('The pump');
  });
  it('marks an unread reply only while the tab is hidden, and clears the mark when the tab is seen', async () => {
    f.answer = titled('th:pond', 'The pond');
    await draw('th:pond', false);
    await see('hidden');
    expect(doc.title).toBe('The pond');
    await draw('th:pond', true);
    expect(doc.title).toBe(UNREAD_MARK + 'The pond');
    await see('visible');
    expect(doc.title).toBe('The pond');
  });
  it('an unread reply in a tab that is being looked at is not marked, and is once the tab is hidden', async () => {
    f.answer = titled('th:pond', 'The pond');
    await draw('th:pond', true);
    expect(doc.title).toBe('The pond');
    await see('hidden');
    expect(doc.title).toBe(UNREAD_MARK + 'The pond');
    // Read somewhere else while this tab stays hidden: the mark goes.
    await draw('th:pond', false);
    expect(doc.title).toBe('The pond');
  });
  it('a tab opened hidden with an unread reply is marked from the start', async () => {
    doc.visibilityState = 'hidden'; f.answer = titled('th:pond', 'The pond');
    await draw('th:pond', true);
    expect(doc.title).toBe(UNREAD_MARK + 'The pond');
  });
  it('leaves Loom behind and stops listening when the page goes', async () => {
    f.answer = titled('th:pond', 'The pond'); await draw('th:pond', true);
    await act(async () => tree!.unmount()); tree = undefined;
    expect(doc.title).toBe('Loom'); expect(f.heard).toEqual([]);
  });
});
