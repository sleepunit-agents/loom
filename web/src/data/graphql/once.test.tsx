/** `useDataOnce`: a read asked once by one POST, never a live selection (docs/specs/boards.md, the pull brick's
 * file patches). The fetch is a fake; no socket is opened. */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import { act, create } from 'react-test-renderer';
const client = vi.hoisted(() => vi.fn());
vi.mock('./client', () => { client(); return {}; });
import { useDataOnce } from './index';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); });

const doc = 'query P($path:String!){patch:changeFilePatch(change:"c",path:$path){state}}';
function Read({ path, pause }: { path: string; pause?: boolean }) {
  return createElement('p', null, JSON.stringify(useDataOnce<{ patch: { state: string } }>(doc, { path }, { pause })));
}

it('asks once by POST to /graphql under the page\'s sign-in, again only for new variables, and never opens a socket', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => Response.json({ data: { patch: { state: JSON.parse(String(init?.body)).variables.path } } }));
  vi.stubGlobal('fetch', fetcher);
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(Read, { path: 'a.ts' })); });
  expect(JSON.stringify(tree.toJSON())).toContain('\\"state\\":\\"a.ts\\"');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('/graphql');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } });
  expect(JSON.parse(String(init!.body))).toEqual({ query: doc, variables: { path: 'a.ts' } });
  // Drawn again with the same variables, it asks nothing.
  await act(async () => tree.update(createElement(Read, { path: 'a.ts' })));
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => tree.update(createElement(Read, { path: 'b.ts' })));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(tree.toJSON())).toContain('\\"state\\":\\"b.ts\\"');
  await act(async () => tree.unmount());
  expect(client).not.toHaveBeenCalled();
});

it('is offline on a failed request or an answer with errors, denied on a refused sign-in, and asks nothing paused', async () => {
  const answers = [new Response('{}', { status: 503 }), Response.json({ errors: [{ message: 'no' }] }), new Response('{}', { status: 401 })];
  const fetcher = vi.fn<typeof fetch>(async () => answers.shift() ?? Promise.reject(new Error('down')));
  vi.stubGlobal('fetch', fetcher);
  for (const want of ['offline', 'offline', 'denied', 'offline']) {
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(createElement(Read, { path: want })); });
    expect(JSON.parse((tree.toJSON() as { children: string[] }).children[0])).toEqual({ status: want });
    await act(async () => tree.unmount());
  }
  fetcher.mockClear();
  let paused!: ReturnType<typeof create>;
  await act(async () => { paused = create(createElement(Read, { path: 'a.ts', pause: true })); });
  expect(JSON.parse((paused.toJSON() as { children: string[] }).children[0])).toEqual({ status: 'loading' });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => paused.unmount());
});

it('asks again once, at once, when the door says a commit landed during the read, and no more than once', async () => {
  const changed = () => Response.json({ errors: [{ message: 'Data changed; retry the query' }] }, { status: 503 });
  const answers = [changed(), Response.json({ data: { patch: { state: 'kept' } } }), changed(), changed()];
  const fetcher = vi.fn<typeof fetch>(async () => answers.shift()!);
  vi.stubGlobal('fetch', fetcher);
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(Read, { path: 'a.ts' })); });
  expect(JSON.parse((tree.toJSON() as { children: string[] }).children[0])).toEqual({ status: 'live', data: { patch: { state: 'kept' } } });
  expect(fetcher).toHaveBeenCalledTimes(2);
  // Twice in a row: offline, and not a third ask.
  await act(async () => tree.update(createElement(Read, { path: 'b.ts' })));
  expect(JSON.parse((tree.toJSON() as { children: string[] }).children[0])).toEqual({ status: 'offline' });
  expect(fetcher).toHaveBeenCalledTimes(4);
  await act(async () => tree.unmount());
  // Any other 503 is not asked again.
  fetcher.mockClear();
  answers.push(Response.json({ errors: [{ message: 'Data request could not complete' }] }, { status: 503 }));
  await act(async () => { tree = create(createElement(Read, { path: 'c.ts' })); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});
