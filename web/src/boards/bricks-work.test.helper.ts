/** The bench the Work bricks' suites share: a brick drawn from a fake data hook, with the desktop's ticket door
 * (POST /api/tasks/command, data/task-command.ts) and the member's other operations answered by a fake fetch, so
 * what is checked is the request loom would receive and what the board is then told. */
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';
import { expect, vi, type Mock } from 'vitest';
import { brickView, type Params } from './bricks';
import type { Form } from './layout';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
export type Data = Record<string, unknown>;
export function bench(feed: Mock) {
  let tree: { root: Node; toJSON(): unknown; update(element: unknown): void; unmount(): void } | undefined;
  const sent = vi.fn(), reported = vi.fn(), raised = vi.fn();
  const reply = { ok: true, value: { id: 't-7' } as Record<string, unknown>, message: '' };
  const said = (node: Node | string): string => (typeof node === 'string' ? node : node.children.map(said).join(''));
  const element = (brick: string, params: Params, form: Form) => h(brickView(brick).Body, { params, form, act: reported, raise: raised });
  const fields = () => tree!.root.findAll((node) => (node.type === 'input' || node.type === 'textarea'));
  const field = (label: string) => fields().find((node) => node.props['aria-label'] === label);
  const buttons = () => tree!.root.findAllByType('button');
  const button = (label: string) => buttons().find((b) => said(b) === label || b.props['aria-label'] === label);
  return {
    sent, reported, raised, reply, said, fields, field, buttons, button,
    before() {
      feed.mockReset(); sent.mockReset(); reported.mockReset(); raised.mockReset();
      Object.assign(reply, { ok: true, value: { id: 't-7' }, message: '' });
      const kept = new Map<string, string>();
      vi.stubGlobal('sessionStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });
      vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
        sent(url, JSON.parse(init.body).input);
        return { ok: reply.ok, status: reply.ok ? 200 : 409, json: async () => (reply.ok ? { ok: true, value: reply.value } : { ok: false, message: reply.message }) };
      });
    },
    async after() { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); },
    /** What each read answers, by the name of its query. `undefined` is a read still loading; a paused read is too. */
    answer(data: Data) {
      feed.mockImplementation((query: string, _variables: unknown, options?: { pause?: boolean }) => {
        const name = /^query (\w+)/.exec(query)![1];
        if (options?.pause) return { status: 'loading' };
        return name in data ? (data[name] === undefined ? { status: 'loading' } : { status: 'live', data: data[name] }) : { status: 'live', data: null };
      });
    },
    /** The variables each read was last asked with, by the name of its query. */
    asked(name: string) { return feed.mock.calls.filter(([query]) => new RegExp(`^query ${name}\\b`).test(query)).at(-1)?.[1]; },
    async draw(brick: string, params: Params, form: Form) { await act(async () => { tree?.unmount(); tree = create(element(brick, params, form)); }); return tree!; },
    async redraw(brick: string, params: Params, form: Form) { await act(async () => tree!.update(element(brick, params, form))); },
    root: () => tree!.root,
    text: () => JSON.stringify(tree!.toJSON()),
    all: () => said(tree!.root),
    /** Everything a member can work that is not a chip. */
    controls: () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a', 'select'].includes(node.type) && !node.props['data-place']),
    placed: () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place'])),
    labels: () => buttons().filter((b) => !b.props['data-place']).map((b) => said(b)),
    press: (label: string) => act(async () => { await button(label)!.props.onClick(); }),
    type: (label: string, value: string) => act(async () => field(label)!.props.onChange({ target: { value } })),
    submit: (label: string) => act(async () => { await tree!.root.findAll((node) => node.type === 'form' && node.props['aria-label'] === label)[0].props.onSubmit({ preventDefault() {} }); }),
    submitNth: (n: number) => act(async () => { await tree!.root.findAllByType('form')[n].props.onSubmit({ preventDefault() {} }); }),
    alert: () => tree!.root.findAll((node) => node.props.role === 'alert').map(said).join(' '),
    /** A compact form is one line: one paragraph of the brief's class and nothing beside it. */
    oneLine() { const json = tree!.toJSON() as { type: string; props: { className: string } }; expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief'); },
  };
}
