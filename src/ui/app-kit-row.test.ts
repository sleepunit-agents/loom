import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { act, create } from '../../web/node_modules/react-test-renderer/index.js';
vi.mock('../../web/src/lib/cojeev-motion/use-reduced-motion', () => ({ useReducedMotion: () => true }));
import { Row, Empty, Loading, Error as ErrorState, AppFrame, List } from '../../web/src/kit/app';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('kit row and app structure', () => {
  it('keeps opening and trailing actions independently operable, never nested', async () => {
    const open = vi.fn(), done = vi.fn(); let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(h(Row, { title: 'One', meta: 'Details', status: 'Ready', selected: true, unread: true, onClick: open,
      icon: h('span', { 'aria-label': 'Agent avatar' }, 'A'), trailing: 'Today', actions: h('button', { onClick: done }, 'Done') })); });
    const text = JSON.stringify(tree.toJSON());
    for (const value of ['One', 'Details', 'Ready', 'Agent avatar', 'Today']) expect(text).toContain(value);
    const buttons = tree.root.findAllByType('button'); expect(buttons).toHaveLength(2);
    expect(buttons[0].findAllByType('button')).toHaveLength(1);
    await act(async () => buttons[1].props.onClick()); expect(done).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
    await act(async () => buttons[0].props.onClick()); expect(open).toHaveBeenCalledOnce();
    expect(buttons[0].props['aria-current']).toBe('true'); expect(buttons[0].props['data-unread']).toBe(true);
    expect(tree.root.findByProps({ 'aria-label': 'Unread' })).toBeTruthy();
    await act(async () => tree.unmount());
  });
  it('renders frame breadcrumbs, filters, menu context and accessible states', () => {
    const html = renderToStaticMarkup(h(AppFrame, { title: 'Changes', where: '/changes', go: () => {}, crumb: { label: 'Home', href: '/' },
      filters: h('input', { 'aria-label': 'Filter' }), about: { label: 'A change', ref: 't-2153' }, children: h(List, { label: 'Changes', children: h(Empty, { title: 'No changes yet', text: 'They land here.' }) }) }));
    expect(html).toContain('data-about='); expect(html).toContain('You are here'); expect(html).toContain('aria-label="Filter"'); expect(html).toContain('No changes yet'); expect(html).toContain('They land here.');
    expect(renderToStaticMarkup(h(Loading, {}))).toContain('role="status"');
    expect(renderToStaticMarkup(h(ErrorState, { retry: () => {} }))).toContain('Try again');
    expect(renderToStaticMarkup(h(ErrorState, {}))).toContain('role="alert"');
  });
});

it('retry invokes the supplied operation', async () => {
  const retry = vi.fn(); let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(h(ErrorState, { retry })); });
  await act(async () => tree.root.findByType('button').props.onClick());
  expect(retry).toHaveBeenCalledOnce(); await act(async () => tree.unmount());
});
