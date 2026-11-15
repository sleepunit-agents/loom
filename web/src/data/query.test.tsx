import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { tasksQuery } from '../pieces/tasks/query';
const selection: QuerySelection<{ title: string } | null> = { query: tasksQuery, decode(data: Record<string, unknown>) { return (data.tasks as { title: string }[])[0] ?? null; } };
const feed = vi.hoisted(() => ({ snapshot: { status: 'loading' } as { status: string; data?: Record<string, unknown> }, read: vi.fn() }));
vi.mock('./graphql', () => ({ useDataQuery(query: string, variables: unknown) { feed.read(query, variables); return feed.snapshot; } }));
import { useQuery, type QuerySelection } from './query';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => { if (tree) await act(() => tree!.unmount()); tree = undefined; });
it('uses the canonical feed, decodes null and hides retained words on connection loss or decoder failure', async () => {
  function Screen() { const result = useQuery(selection); return createElement('p', null, result.status === 'live' ? result.data?.title ?? 'Gone' : result.status); }
  const draw = async () => act(() => { if (tree) tree.update(createElement(Screen)); else tree = create(createElement(Screen)); });
  await draw(); expect(JSON.stringify(tree!.toJSON())).toContain('loading');
  feed.snapshot = { status: 'live', data: { tasks: [{ id: 't-1', title: 'Fictional page' }] } };
  await draw(); expect(JSON.stringify(tree!.toJSON())).toContain('Fictional page');
  expect(feed.read).toHaveBeenLastCalledWith(selection.query, selection.variables);
  feed.snapshot = { status: 'live', data: { tasks: [] } };
  await draw(); expect(JSON.stringify(tree!.toJSON())).toContain('Gone');
  feed.snapshot = { status: 'offline', data: { tasks: [{ title: 'Retained private words' }] } };
  await draw(); expect(JSON.stringify(tree!.toJSON())).toContain('offline'); expect(JSON.stringify(tree!.toJSON())).not.toContain('Retained');
  function Broken() { const result = useQuery({ ...selection, decode() { throw Error('invalid'); } }); return createElement('p', null, result.status); }
  feed.snapshot = { status: 'live', data: {} };
  await act(() => tree!.update(createElement(Broken))); expect(JSON.stringify(tree!.toJSON())).toContain('error');
});
