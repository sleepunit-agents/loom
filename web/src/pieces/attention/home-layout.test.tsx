import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
// @ts-expect-error Existing renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import Home from './home';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ status: 'loading', removedAt: null as string | null }));
vi.mock('../../data/graphql', () => ({
  useDataQuery(document: string) {
    if (!document.includes('query DeskRoster')) return { status: 'loading' };
    return {
      status: fixture.status,
      data: {
        homeComms: { member: 'owner', agents: ['art', 'mark'] },
        agents: [{ id: 'art', position: 0 }, { id: 'mark', position: 1, removedAt: fixture.removedAt }],
      },
    };
  },
}));

it('waits for the live roster, keeps two cards, and gives a single live agent the desk', async () => {
  const go = vi.fn();
  let tree!: ReturnType<typeof create>;
  const sections = () => tree.root.findAllByType('section');
  const cards = () => sections().filter((node: { props: { className?: string } }) => node.props.className?.startsWith('desk-home-card'));
  const desk = () => tree.root.findAllByProps({ className: 'desk-solo' });
  try {
    await act(async () => { tree = create(createElement(Home, { go })); });
    expect(cards()).toHaveLength(0);
    expect(desk()).toHaveLength(0);
    fixture.status = 'live';
    await act(async () => { tree.update(createElement(Home, { go })); });
    expect(cards()).toHaveLength(2);
    fixture.removedAt = '2026-11-19';
    await act(async () => { tree.update(createElement(Home, { go })); });
    expect(cards()).toHaveLength(0);
    expect(desk()).toHaveLength(1);
    expect(desk()[0].props['data-agent']).toBe('art');
    const open = desk()[0].findByProps({ className: 'desk-home-open' });
    open.props.onClick({ preventDefault() {} });
    expect(go).toHaveBeenCalledWith('/p/agents-preview/agent/art');
  } finally {
    if (tree) await act(async () => { tree.unmount(); });
  }
});
