/** What of the member's Appearance the boards page wears: Reduce motion and nothing else, from the member's own
 * row, and the device's setting until that row is known. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
const f = vi.hoisted(() => ({ feed: vi.fn(), wearMotion: vi.fn() }));
vi.mock('../data/graphql', () => ({ useDataQuery: f.feed }));
vi.mock('../access', () => ({ wearMotion: f.wearMotion }));
import { homeCommsQuery } from '../pieces/attention/home-comms-data';
import { memberPreferencesQuery } from '../shell/member-preferences';
import { Wear, WORN_WORDS } from './wear';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (member: string, over: object = {}) => ({ member, look: 'daylight', ground: 'wash', sound: true, pixel: false, haptics: false, oneWindow: true, zoom: true, motion: 'follow', contrast: 'on', changedAt: '2026-11-27T00:00:00Z', ...over });
let tree: { unmount(): void; update(element: unknown): void; toJSON(): unknown } | undefined;
const world = { home: { status: 'live', data: { homeComms: { member: 'sam' } } } as object, prefs: { status: 'loading' } as object };
beforeEach(() => {
  f.feed.mockReset(); f.wearMotion.mockReset();
  world.home = { status: 'live', data: { homeComms: { member: 'sam' } } }; world.prefs = { status: 'loading' };
  f.feed.mockImplementation((query: string) => (query === homeCommsQuery ? world.home : query === memberPreferencesQuery ? world.prefs : { status: 'live', data: null }));
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });
const draw = () => act(async () => { if (tree) tree.update(h(Wear)); else tree = create(h(Wear)); });

it('wears the member\'s own Reduce motion, and again when the record changes', async () => {
  await draw();
  expect(f.wearMotion).not.toHaveBeenCalled(); // not known yet: the page keeps the device's setting it started with
  world.prefs = { status: 'live', data: { memberPreferences: [row('robin', { motion: 'off' }), row('sam', { motion: 'on' })] } };
  await draw();
  expect(f.wearMotion.mock.calls).toEqual([['on']]);
  world.prefs = { status: 'live', data: { memberPreferences: [row('sam', { motion: 'off' })] } };
  await draw();
  expect(f.wearMotion.mock.calls).toEqual([['on'], ['off']]);
  expect(f.feed.mock.calls.every(([, , options]) => options?.keep === true)).toBe(true);
  expect(tree!.toJSON()).toBeNull();
});

it('follows the device for a member who has saved nothing, and keeps what it wore when the record cannot be read', async () => {
  world.prefs = { status: 'live', data: { memberPreferences: [row('robin', { motion: 'on' })] } };
  await draw();
  expect(f.wearMotion.mock.calls).toEqual([['follow']]);
  world.prefs = { status: 'offline' };
  await draw();
  world.home = { status: 'live', data: { homeComms: null } };
  await draw();
  expect(f.wearMotion.mock.calls).toEqual([['follow']]);
});

it('wears nothing else: no look, contrast or other attribute is set from the record', async () => {
  const dataset = (document.documentElement as unknown as { dataset: object }).dataset;
  world.prefs = { status: 'live', data: { memberPreferences: [row('sam', { motion: 'on' })] } };
  await draw();
  expect(dataset).toEqual({});
  expect(WORN_WORDS).toContain('only Reduce motion takes effect');
});

it('the page\'s build routes every motion media query onto the attribute this wears, as the desktop\'s build does', async () => {
  const { readFileSync } = await import('node:fs');
  const config = readFileSync(new URL('../../vite.boards.config.ts', import.meta.url), 'utf8');
  expect(config).toContain("import { accessMedia } from './access-media.ts';");
  expect(config).toContain('css: { postcss: { plugins: [accessMedia()] } }');
});
