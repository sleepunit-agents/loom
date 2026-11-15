import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error The renderer dependency has no bundled declarations.
import { act, create } from 'react-test-renderer';
const f = vi.hoisted(() => ({ snapshot: { status: 'live', data: undefined } as any, query: vi.fn() }));
vi.mock('../../data/graphql', () => ({ useDataQuery: (document: string, variables: unknown) => { f.query(document, variables); return f.snapshot; } }));
import { LastAnswer } from './last-answer';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { if (tree) await act(async () => tree.unmount()); f.query.mockClear(); });
const conversation = (id: string, at: string, words: string | null) => ({ id, agent: 'art', label: id, lastAnswer: words === null ? null : { at, words } });
const draw = async () => { await act(async () => { tree = create(h(LastAnswer, { agent: 'art', name: 'Art' })); }); };
const text = () => JSON.stringify(tree.toJSON());
it('selects the latest answered conversation and shows the latest available agent answer as plain words', async () => {
 f.snapshot = { status: 'live', data: { recentConversations: [conversation('new-chat', '2026-11-14T12:00:00Z', null), conversation('older-chat', '2026-11-14T11:00:00Z', '<script>agent words</script>'), conversation('other-chat', '2026-11-14T10:00:00Z', 'Earlier reply')] } };
 await draw();
 expect(f.query).toHaveBeenCalledWith(expect.stringContaining('recentConversations(agent: $agent, limit: 1, answeredOnly: true)'), { agent: 'art' });
 expect(f.query.mock.calls[0][0]).not.toMatch(/messages|threads|answer\s*\{/);
 expect(text()).toContain('<script>agent words</script>'); expect(text()).not.toContain('Earlier reply');
 expect(tree.root.findAllByType('script')).toHaveLength(0);
});
it.each(['loading', 'offline', 'denied'])('clears retained private answer words when %s', async status => {
 const data = { recentConversations: [conversation('chat', '2026-11-14T11:00:00Z', 'Private retained words')] };
 f.snapshot = { status: 'live', data }; await draw(); expect(text()).toContain('Private retained words');
 f.snapshot = { status, data }; await act(async () => tree.update(h(LastAnswer, { agent: 'art', name: 'Art' })));
 expect(text()).not.toContain('Private retained words'); expect(text()).toContain('Answer unavailable');
});
it('distinguishes an empty current result and removes an expired answer without reviving old text', async () => {
 f.snapshot = { status: 'live', data: { recentConversations: [conversation('chat', '2026-11-14T11:00:00Z', 'Expired words')] } }; await draw();
 f.snapshot = { status: 'live', data: { recentConversations: [conversation('chat', '2026-11-14T11:00:00Z', null)] } };
 await act(async () => tree.update(h(LastAnswer, { agent: 'art', name: 'Art' })));
 expect(text()).not.toContain('Expired words'); expect(text()).toContain('No retained agent answer.');
});
