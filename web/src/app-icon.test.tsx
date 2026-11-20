import { expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
vi.mock('@/components/ui/animated-icon', () => ({ AnimatedIcon: (props: Record<string, unknown>) => h('line-icon', props) }));
import { AppIcon, houseIcon } from './app-icon';
import { HOUSE_ICONS } from './assets/house-icons';
import { apps } from './apps';

type Node = { type: unknown; props: Record<string, any> };
const draw = (props: Parameters<typeof AppIcon>[0]) => { let tree!: ReturnType<typeof create>; act(() => { tree = create(h(AppIcon, props)); }); return tree; };
const only = (tree: ReturnType<typeof create>) => tree.toJSON() as Node;

it('draws the house icon for an app in the set, by its id, and the line icon for one that is not', () => {
  const tasks = only(draw({ app: 'tasks', name: 'list-checks' }));
  expect(tasks.type).toBe('img');
  expect(tasks.props).toMatchObject({ className: 'loom-house', 'data-app': 'tasks', width: 32, height: 32, alt: '', style: { width: 32, height: 32 } });
  expect(tasks.props.srcSet).toBe(`${HOUSE_ICONS.tasks.small} 1x, ${HOUSE_ICONS.tasks.art} 4x`);
  const none = only(draw({ app: 'home-preview', name: 'book-open', size: 'sm' }));
  expect(none.type).toBe('line-icon');
  expect(none.props).toMatchObject({ name: 'book-open', size: 'sm' });
});
it('goes by the id and never by a title or the line icon’s name', () => {
  expect(houseIcon('Tasks')).toBeUndefined();
  expect(houseIcon(undefined)).toBeUndefined();
  expect(houseIcon('toString')).toBeUndefined();
  expect(only(draw({ name: 'inbox' })).type).toBe('line-icon');
  expect(only(draw({ app: 'Inbox', name: 'inbox' })).type).toBe('line-icon');
  // every icon in the set is a registered app's (or one of the dock's own two keys)
  const ids = new Set([...apps.map(app => app.id), 'home', 'launcher']);
  for (const app of Object.keys(HOUSE_ICONS)) expect(ids.has(app), app).toBe(true);
});
it('draws the same art small, from the file that fits the slot', () => {
  const small = only(draw({ app: 'inbox', name: 'inbox', size: 'sm' }));
  expect(small.type).toBe('img');
  expect(small.props).toMatchObject({ src: HOUSE_ICONS.inbox.small, width: 16, height: 16, srcSet: `${HOUSE_ICONS.inbox.small} 2x, ${HOUSE_ICONS.inbox.art} 8x` });
  const strip = only(draw({ app: 'inbox', name: 'inbox', size: 'sm', house: 24 }));
  expect(strip.props).toMatchObject({ width: 24, srcSet: `${HOUSE_ICONS.inbox.small} 1.333x, ${HOUSE_ICONS.inbox.art} 5.333x` });
  const tile = only(draw({ app: 'inbox', name: 'inbox', house: 40 }));
  expect(tile.props).toMatchObject({ src: HOUSE_ICONS.inbox.art, width: 40, srcSet: undefined });
});
it('falls back to the line icon when the file will not load', () => {
  const tree = draw({ app: 'tempo', name: 'clock' });
  act(() => only(tree).props.onError());
  expect(only(tree).type).toBe('line-icon');
  expect(only(tree).props.name).toBe('clock');
});
