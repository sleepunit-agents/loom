import { createElement } from 'react';
import { it, expect, vi } from 'vitest';
// @ts-expect-error The renderer ships without types.
import { create, act } from 'react-test-renderer';
import { Effects } from './effects';
const f = vi.hoisted(() => ({ useRecords: vi.fn(), call: vi.fn() }));
vi.mock('../data', () => f);
it('opens a staged effect by id, grounds chat and drops its record when the feed becomes unavailable', async () => {
  const quote = vi.fn(),
    talk = vi.fn(),
    open = vi.fn();
  const props = { target: { kind: 'effect' as const, id: 'held-1' }, quote, talk, open };
  f.useRecords.mockReturnValue({
    status: 'live',
    records: [{ id: 'held-1', title: 'Held wake', kind: 'wake', state: 'due' }],
  });
  let tree: ReturnType<typeof create>;
  await act(async () => {
    tree = create(createElement(Effects, props));
  });
  expect(f.useRecords).toHaveBeenCalledWith('core.effect');
  expect(quote).toHaveBeenCalledWith(expect.stringContaining('Held wake'));
  tree.root
    .findAllByType('button')
    .find((b: { children: string[] }) => b.children.includes('Discuss with Art'))
    .props.onClick();
  expect(talk).toHaveBeenCalledOnce();
  expect(f.call).not.toHaveBeenCalled();
  f.useRecords.mockReturnValue({ status: 'denied', records: [] });
  await act(async () => tree.update(createElement(Effects, props)));
  expect(JSON.stringify(tree.toJSON())).not.toContain('Held wake');
  expect(quote).toHaveBeenLastCalledWith('');
  await act(async () => tree.unmount());
});
