/** The `appearance` brick (docs/specs/boards.md, "The first bricks"): the member's own Appearance choices from the
 * desktop shell's selection, each saved by `household.setPreferences`, and the one line saying which of them this
 * page wears. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
vi.mock('../access', () => ({ wearMotion() {} }));
import { homeCommsQuery } from '../pieces/attention/home-comms-data';
import { memberPreferencesQuery } from '../shell/member-preferences';
import { bricks, loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';
import { WORN_WORDS } from './wear';

await loadBricks();

const b = bench(feed);
beforeEach(b.before);
afterEach(b.after);

const row = (member: string, over: object = {}) => ({ member, look: 'lowlight', ground: 'wash', sound: true, pixel: true, haptics: false, oneWindow: false, zoom: false, motion: 'on', contrast: 'follow', changedAt: '2026-11-27T00:00:00Z', ...over });
function answer(prefs: object, home: object = { status: 'live', data: { homeComms: { member: 'sam' } } }) {
  feed.mockImplementation((query: string) => (query === homeCommsQuery ? home : query === memberPreferencesQuery ? prefs : { status: 'live', data: null }));
}
const rows = (list: object[]) => ({ status: 'live', data: { memberPreferences: list } });
const pressed = () => b.buttons().filter((button) => button.props['aria-pressed']).map((button) => button.props['aria-label']);

it('shows the member\'s own saved choices as rows of buttons, and says which of them this page wears', async () => {
  answer(rows([row('robin', { look: 'daylight', motion: 'off' }), row('sam')]));
  await b.draw('appearance', {}, 'primary');
  expect(feed.mock.calls.every(([, , options]) => options?.keep === true)).toBe(true);
  expect(pressed()).toEqual(['Reduce motion: On', 'Look: Low Light', 'Desk background: Wash', 'Higher contrast: Follow this device', 'Pixel faces: On', 'Sound: On', 'Haptics: Off', 'One window at a time: Off', 'Allow zoom: Off']);
  expect(b.labels()).toEqual(['Follow this device', 'On', 'Off', 'Neon Noir', 'Low Light', 'Daylight', 'Depth', 'Contours', 'Wash', 'Follow this device', 'On', 'Off', ...Array(5).fill(['On', 'Off']).flat()]);
  expect(b.all()).toContain(WORN_WORDS);
  expect(WORN_WORDS).toBe('On this page only Reduce motion takes effect. This page keeps its own look, light or dark as this device is, and has no higher-contrast styling; the other choices are for the desktop.');
  // Reduce motion is the one under the first heading; everything else is under "For the desktop".
  expect(b.all().indexOf('Takes effect on this page')).toBeLessThan(b.all().indexOf('Reduce motion' + 'Follow'));
  expect(b.all().indexOf('For the desktop')).toBeLessThan(b.all().indexOf('Look' + 'Neon'));
  expect(b.all().indexOf('Reduce motion' + 'Follow')).toBeLessThan(b.all().indexOf('For the desktop'));
  expect(b.root().findAll((node) => node.type === 'select')).toEqual([]);
  expect(b.placed()).toEqual([]);
  expect(bricks.appearance.title({})).toBe('Appearance');
  expect(bricks.appearance.sub({})).toBe('');
});

it('the small forms say the choices and hold no control; a member who has saved nothing sees the defaults', async () => {
  answer(rows([row('sam')]));
  await b.draw('appearance', {}, 'side');
  for (const shown of ['Look', 'Low Light', 'Reduce motion', 'On', 'Desk background', 'Wash', WORN_WORDS]) expect(b.all(), shown).toContain(shown);
  expect(b.controls()).toEqual([]);
  await b.draw('appearance', {}, 'compact');
  b.oneLine();
  expect(b.all()).toBe('Low Light · Reduce motion: On');
  expect(b.controls()).toEqual([]);
  answer(rows([row('robin')]));
  await b.draw('appearance', {}, 'compact');
  expect(b.all()).toBe('Neon Noir · Reduce motion: Follow this device');
  await b.draw('appearance', {}, 'primary');
  expect(pressed()).toEqual(['Reduce motion: Follow this device', 'Look: Neon Noir', 'Desk background: Depth', 'Higher contrast: Follow this device', 'Pixel faces: On', 'Sound: Off', 'Haptics: On', 'One window at a time: Off', 'Allow zoom: Off']);
});

it('says so while it loads and when it cannot be read, and then draws no control', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    answer({ status: 'loading' });
    await b.draw('appearance', {}, form);
    expect(b.all(), form).toBe('Loading…');
    for (const [prefs, home] of [[{ status: 'offline' }, undefined], [{ status: 'denied' }, undefined], [rows([row('sam')]), { status: 'live', data: { homeComms: null } }], [rows([row('sam'), row('sam')]), undefined]] as const) {
      answer(prefs, home);
      await b.draw('appearance', {}, form);
      expect(b.all(), form).toBe('Your appearance settings are unavailable.');
      expect(b.controls()).toEqual([]);
    }
  }
  expect(b.sent).not.toHaveBeenCalled();
});

it('a press saves that one choice by the desktop\'s operation and tells the board only that a choice was saved', async () => {
  answer(rows([row('sam')]));
  await b.draw('appearance', {}, 'primary');
  await b.press('Reduce motion: Off');
  await b.press('Look: Daylight');
  await b.press('Desk background: Contours');
  await b.press('Higher contrast: On');
  await b.press('Sound: Off');
  await b.press('Allow zoom: On');
  expect(b.sent.mock.calls).toEqual([
    ['/api/household/setPreferences', { motion: 'off' }], ['/api/household/setPreferences', { look: 'daylight' }], ['/api/household/setPreferences', { ground: 'contours' }],
    ['/api/household/setPreferences', { contrast: 'on' }], ['/api/household/setPreferences', { sound: false }], ['/api/household/setPreferences', { zoom: true }],
  ]);
  expect(b.reported.mock.calls).toEqual(Array(6).fill(['set', {}]));
  expect(b.all()).toContain('Saved.');
  // What is pressed is the record's, not the click's: nothing changes until the record does.
  expect(pressed()[0]).toBe('Reduce motion: On');
  answer(rows([row('sam', { motion: 'off' })]));
  await b.redraw('appearance', {}, 'primary');
  expect(pressed()[0]).toBe('Reduce motion: Off');
});

it('pressing the choice already saved sends nothing, and a refused save says so and reports nothing', async () => {
  answer(rows([row('sam')]));
  await b.draw('appearance', {}, 'primary');
  await b.press('Reduce motion: On');
  expect(b.sent).not.toHaveBeenCalled();
  b.reply.ok = false;
  await b.press('Look: Daylight');
  expect(b.sent).toHaveBeenCalledOnce();
  expect(b.all()).toContain('Could not confirm the save. Your live choices are still shown.');
  expect(b.reported).not.toHaveBeenCalled();
});
