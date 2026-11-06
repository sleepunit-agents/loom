// The tiling rule (docs/specs/desk-tiling.md, "The rule", criteria 1 to 9): a pure function, so no browser.
import { describe, it, expect } from 'vitest';
import { admit, capFor, columnWidth, GUTTER, layout, place, promote, swap, underMinimum, type AppTile, type Rect, type WidgetTile } from '../../web/src/tiling/layout';
import { AGENT_FIT, fitFor } from '../../web/src/tiling/fit';
import { addable, AGENTS, freshSet, SEED, widgetRef } from '../../web/src/tiling/widgets';

const app = (name: string, pinned = false): AppTile => ({ id: name.toLowerCase(), name, fit: fitFor(name), ...(pinned ? { pinned } : {}) });
const area = (w: number, h: number): Rect => ({ x: 0, y: 0, w, h });
const W = { needs: { id: 'needs', name: 'Needs you', kind: 'needs' }, art: { id: 'art', name: 'Art', kind: 'agent' }, mark: { id: 'mark', name: 'Mark', kind: 'agent' },
  vitals: { id: 'vitals', name: 'Vitals', kind: 'vitals' }, backup: { id: 'backup', name: 'Backup', kind: 'backup' } } satisfies Record<string, WidgetTile>;
const three = [W.needs, W.art, W.mark];
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, A: Rect) => r.x >= A.x && r.y >= A.y && r.x + r.w <= A.x + A.w + 0.001 && r.y + r.h <= A.y + A.h + 0.001;

describe('the tiling rule', () => {
  it('1. one fills, two sit side by side, three put the first on the left and the others stacked', () => {
    const A = area(1920, 890);
    const one = layout([app('Inbox')], [], A, 1920);
    expect(one.apps.inbox).toEqual(A);
    const two = layout([app('Inbox'), app('Comms')], [], A, 1920);
    expect(two.apps.inbox.y).toBe(0); expect(two.apps.comms.y).toBe(0);
    expect(two.apps.comms.x - (two.apps.inbox.x + two.apps.inbox.w)).toBe(GUTTER);
    expect(two.apps.inbox.w + GUTTER + two.apps.comms.w).toBe(1920);
    const apps = [app('Tasks'), app('Inbox'), app('Comms')];
    const t = layout(apps, [], A, 1920);
    expect(t.apps.tasks).toMatchObject({ x: 0, y: 0, h: 890 });
    expect(t.apps.inbox.x).toBe(t.apps.comms.x);
    expect(t.apps.inbox.x).toBe(t.apps.tasks.w + GUTTER);
    expect(t.apps.comms.y).toBe(t.apps.inbox.h + GUTTER);
    for (const a of apps) { expect(t.apps[a.id].w).toBeGreaterThanOrEqual(a.fit.min[0]); expect(t.apps[a.id].h).toBeGreaterThanOrEqual(a.fit.min[1]); }
    // "Widest of the rest" is the largest ideal among them (Inbox's 760), not the first of them (Comms's 680).
    expect(layout([app('Tasks'), app('Comms'), app('Inbox')], [], A, 1920).apps.tasks.w).toBe(1104);
  });

  it('2. dwindle: at 2560×1300 the fourth app sits beside the third, under the second', () => {
    const l = layout([app('Tasks'), app('Inbox'), app('Comms'), app('Knowledge')], [], area(2560, 1300), 2560);
    const [second, third, fourth] = [l.apps.inbox, l.apps.comms, l.apps.knowledge];
    expect(third.y).toBe(fourth.y);
    expect(fourth.x).toBe(third.x + third.w + GUTTER);
    expect(third.y).toBe(second.y + second.h + GUTTER);
    expect(third.x).toBe(second.x);
    // Every split is the same step: Comms's share of its own region is from Comms's and Knowledge's ideals.
    const region = third.w + GUTTER + fourth.w;
    expect(third.w).toBe(Math.round((region - GUTTER) * 680 / (680 + 760)));
    // The threshold: wider than 1.15 times its height is side by side, else stacked.
    const side = layout([app('Inbox'), app('Comms')], [], area(1200, 1000), 1920);
    expect(side.apps.comms.y).toBe(0);
    const stacked = layout([app('Inbox'), app('Comms')], [], area(1100, 1000), 1920);
    expect(stacked.apps.comms.x).toBe(0);
    expect(stacked.apps.comms.y).toBeGreaterThan(0);
  });

  it('3. fit sets the ratio, and a max stops the first', () => {
    const l = layout([app('Tasks'), app('Comms')], [], area(1538, 900), 1920);
    expect(l.apps.tasks.w).toBe(Math.round(1528 * 1040 / 1720));
    expect(l.apps.tasks.w).toBe(924);
    expect(l.apps.comms.w).toBe(604);
    const b = layout([app('Boxes'), app('Tasks')], [], area(3200, 1300), 3200);
    expect(b.apps.boxes.w).toBe(1200);
    expect(b.apps.tasks.w).toBe(3200 - 1200 - GUTTER);
    // The max wins over the 34 percent floor.
    expect(layout([app('Setup'), app('Tasks')], [], area(3000, 1300), 3000).apps.setup.w).toBe(680);
    // Both capped: the ratio stands.
    const both = layout([app('Comms'), app('Inbox')], [], area(1810, 900), 1920);
    expect([both.apps.comms.w, both.apps.inbox.w]).toEqual([850, 950]);
    // The 34 percent floor: Setup's raw 607 px is clamped up.
    expect(layout([app('Setup'), app('Changes')], [], area(1810, 900), 1920).apps.setup.w).toBe(612);
    // The 66 percent ceiling: Changes's raw 66.3 percent (1,193 px) is clamped down to 1,188.
    expect(layout([app('Changes'), app('Setup')], [], area(1810, 900), 1920).apps.changes.w).toBe(1188);
    // The first has no max and the rest have one: it takes what they can't use.
    const noMax = layout([app('Tasks'), app('Comms')], [], area(3000, 1300), 3000);
    expect([noMax.apps.tasks.w, noMax.apps.comms.w]).toEqual([2170, 820]);
  });

  it('4. a big app takes the big slot, unless the person made another the big one', () => {
    expect(place([app('Comms')], app('Tasks')).map((a) => a.name)).toEqual(['Tasks', 'Comms']);
    expect(place([app('Tasks')], app('Comms')).map((a) => a.name)).toEqual(['Tasks', 'Comms']);
    const pinned = promote([app('Inbox'), app('Comms')], 'comms');
    expect(pinned.map((a) => [a.name, !!a.pinned])).toEqual([['Comms', true], ['Inbox', false]]);
    expect(place(pinned, app('Tasks')).map((a) => a.name)).toEqual(['Comms', 'Inbox', 'Tasks']);
    // Opened from a tile: right after it; from a widget: last, next to the rail.
    expect(place([app('Inbox'), app('Comms')], app('Tasks'), { tile: 'inbox' }).map((a) => a.name)).toEqual(['Inbox', 'Tasks', 'Comms']);
    expect(place([app('Comms')], app('Tasks'), { widget: true }).map((a) => a.name)).toEqual(['Comms', 'Tasks']);
    // Only one is pinned: making another the big one unpins the first.
    expect(promote(pinned, 'inbox').map((a) => [a.name, !!a.pinned])).toEqual([['Inbox', true], ['Comms', false]]);
    // Swapping a pinned tile out of the big slot unpins it.
    expect(swap(pinned, 0, 1).map((a) => [a.name, !!a.pinned])).toEqual([['Inbox', false], ['Comms', false]]);
  });

  it('5. widgets never split the app area, and with no apps they group as Home does', () => {
    const sets = [[app('Comms')], [app('Tasks'), app('Comms')], [app('Tasks'), app('Comms'), app('Inbox')], [app('Tasks'), app('Comms'), app('Inbox'), app('Knowledge')]];
    for (const screen of [1280, 1600, 1920]) for (const apps of sets) {
      const l = layout(apps, three, area(screen - 48, 800), screen);
      for (const w of three) expect(l.widgets[w.id].w, `${screen}, ${apps.length} apps`).toBeLessThanOrEqual(340);
    }
    const desk = layout([], [W.vitals, W.art, W.needs, W.mark, W.backup], area(1900, 900), 1920);
    expect(desk.mode).toBe('desk');
    expect(desk.groups).toEqual([['needs'], ['art', 'mark'], ['vitals', 'backup']]);
  });

  it('6. the widgets get columns, a rail or the strip', () => {
    const board = layout([app('Comms')], three, area(1872, 890), 1920);
    expect([board.mode, board.cols]).toEqual(['board', 2]);
    // Columns by fit, not by groups: three groups, room for two 300 px columns; the last two groups share the last.
    const fitCols = layout([app('Comms')], [W.needs, W.art, W.vitals], area(1552, 800), 1600);
    expect([fitCols.mode, fitCols.cols]).toEqual(['board', 2]);
    expect([fitCols.widgets.needs.x, fitCols.widgets.art.x, fitCols.widgets.vitals.x]).toEqual([1252 - 310, 1252, 1252]);
    expect(fitCols.widgets.vitals.y).toBeGreaterThan(fitCols.widgets.art.y);
    const rail = layout([app('Tasks'), app('Comms')], three, area(1872, 890), 1920);
    expect(rail.mode).toBe('rail');
    expect(rail.widgetArea!.w).toBe(340);
    expect(rail.widgets.art.w).toBe(340);
    expect(layout([app('Tasks'), app('Comms')], three, area(1552, 800), 1600).widgetArea!.w).toBe(300);
    const r1280 = layout([app('Tasks'), app('Comms')], three, area(1232, 800), 1280);
    expect([r1280.mode, r1280.widgetArea!.w]).toEqual(['rail', 280]);
    const strip = layout([app('Tasks'), app('Changes')], three, area(1232, 600), 1280);
    expect(strip.mode).toBe('strip');
    expect(strip.widgetArea!.w).toBe(64);
    expect(Object.values(strip.widgets).map((r) => [r.w, r.h])).toEqual([[64, 64], [64, 64], [64, 64]]);
    // "Combined" alternates: Tasks beside (Comms over Inbox) needs 520 + 10 + 420 = 950, not their sum (1,340), so there's
    // room for a 300 px rail, not only the strip.
    expect(layout([app('Tasks'), app('Comms'), app('Inbox')], three, area(1552, 800), 1600).mode).toBe('rail');
    // The column's width at each threshold.
    expect([1439, 1440, 1919, 1920].map(columnWidth)).toEqual([280, 300, 300, 340]);
    // A rail taller than the screen draws its cards compact, then scrolls.
    const cards = (n: number): WidgetTile[] => [W.needs, ...Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `A${i}`, kind: 'agent' as const }))];
    const tall = layout([app('Tasks'), app('Comms')], cards(3), area(1872, 600), 1920);
    expect([tall.widgets.a0.compact, tall.widgets.needs.compact, tall.scroll]).toEqual([true, true, false]);
    expect(layout([app('Tasks'), app('Comms')], cards(7), area(1872, 600), 1920).scroll).toBe(true);
    expect(layout([app('Tasks'), app('Comms')], three, area(1872, 890), 1920).widgets.art.compact).toBeUndefined();
  });

  it('7. too small: the least recently used app goes to the dock, never the one opened, the one it came from, or a pinned one', () => {
    const A = area(1232, 597);
    const used = { tasks: 2, comms: 1 };
    const r = admit([app('Tasks'), app('Comms')], app('Changes'), [], A, 1280, { usedAt: used });
    expect(r.docked.map((d) => d.app.name)).toEqual(['Comms']);
    expect(r.docked[0].why).toBe('Comms went to the dock to make room for Changes: it would have been under its 360 px minimum height');
    expect(underMinimum(r.apps, [], A, 1280)).toBeUndefined();
    for (const a of r.apps) { const l = layout(r.apps, [], A, 1280).apps[a.id]; expect(l.w).toBeGreaterThanOrEqual(a.fit.min[0]); expect(l.h).toBeGreaterThanOrEqual(a.fit.min[1]); }
    // Comms is the one it came from: Tasks goes instead, though Comms was used less recently.
    const from = admit([app('Tasks'), app('Comms')], app('Changes'), [], A, 1280, { usedAt: used, from: { tile: 'comms' } });
    expect(from.docked.map((d) => d.why)).toEqual(['Tasks went to the dock to make room for Changes: Comms would have been under its 360 px minimum height']);
    // Comms is pinned: Tasks goes.
    const pin = admit(promote([app('Tasks'), app('Comms')], 'comms'), app('Changes'), [], A, 1280, { usedAt: used });
    expect(pin.docked.map((d) => d.app.name)).toEqual(['Tasks']);
    expect(pin.apps.map((a) => a.name)).toContain('Changes');
    // The strip takes its 64 px: the two apps then don't fit beside it, so one goes to the dock, and the one left has a
    // rail again.
    expect(layout([app('Tasks'), app('Changes')], three, area(1104, 700), 1152).mode).toBe('strip');
    const strip = admit([app('Tasks')], app('Changes'), three, area(1104, 700), 1152);
    expect(strip.docked.map((d) => d.app.name)).toEqual(['Tasks']);
    expect(layout(strip.apps, three, area(1104, 700), 1152).mode).toBe('rail');
  });

  it('8. the cap: a third app at 1279 px sends one to the dock; at 1280 it fits', () => {
    expect([capFor(1279), capFor(1280), capFor(1599), capFor(1600), capFor(2559), capFor(2560)]).toEqual([2, 3, 3, 4, 4, 6]);
    const apps = [app('Inbox'), app('Comms')];
    expect(admit(apps, app('Knowledge'), [], area(1231, 760), 1279).docked.map((d) => d.why)).toEqual(['Inbox went to the dock to make room for Knowledge: 2 apps is the most this screen holds']);
    expect(admit(apps, app('Knowledge'), [], area(1232, 760), 1280).docked).toEqual([]);
    const set = ['Appearance', 'Accessibility', 'Account', 'Passkeys'].map((n) => app(n));
    expect(admit(set.slice(0, 3), app('Passkeys'), [], area(1551, 1000), 1599).docked.map((d) => d.why)).toEqual(['Appearance went to the dock to make room for Passkeys: 3 apps is the most this screen holds']);
    expect(admit(set.slice(0, 3), app('Passkeys'), [], area(1552, 1000), 1600).docked).toEqual([]);
    expect(admit(set, app('Secrets'), [], area(2511, 1300), 2559).docked.map((d) => d.why)).toEqual(['Appearance went to the dock to make room for Secrets: 4 apps is the most this screen holds']);
    expect(admit(set, app('Secrets'), [], area(2512, 1300), 2560).docked).toEqual([]);
  });

  it('fit: an agent\'s pages, a core app, a piece\'s own and the default', () => {
    expect(AGENT_FIT).toMatchObject({ min: [420, 360], ideal: 760, max: 1000, big: false });
    expect(fitFor('Comms')).toMatchObject({ min: [380, 360], ideal: 680, max: 820, big: false });
    expect(fitFor('Garden')).toMatchObject({ min: [420, 300], ideal: 720, max: null, big: false });
    expect(fitFor('Garden', { ideal: 900, max: 1000 })).toMatchObject({ min: [420, 300], ideal: 900, max: 1000, big: false });
  });

  it('9. deterministic: the same tiles at the same size give the same boxes', () => {
    const apps = [app('Tasks'), app('Comms'), app('Inbox'), app('Knowledge')];
    const first = layout(apps, three, area(1872, 890), 1920);
    layout([...apps].reverse(), [W.vitals], area(1232, 597), 1280);
    expect(layout(apps, three, area(1872, 890), 1920)).toEqual(first);
  });

  it('17 (the rule half). no two boxes overlap and every box is inside the area', () => {
    for (const [screen, h] of [[1280, 597], [1920, 890]]) {
      const A = area(screen - 20, h);
      for (let n = 1; n <= 4; n++) {
        const apps = [app('Tasks'), app('Comms'), app('Inbox'), app('Knowledge')].slice(0, n);
        const l = layout(apps, three, A, screen);
        const boxes = [...Object.values(l.apps), ...Object.values(l.widgets).filter(() => !l.scroll)];
        for (const b of boxes) expect(inside(b, A), `${screen} ${n}`).toBe(true);
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${screen} ${n} ${i}/${j}`).toBe(false);
      }
    }
  });
});

describe('the widgets the desktop can show (tiling/widgets.ts)', () => {
  const agents = [{ id: 'art', label: 'Art' }, { id: 'mark', label: 'Mark' }];
  it('a fresh device starts with the seed: Needs you, each agent\'s card, Vitals, Backup and the ticker', () => {
    expect(SEED).toEqual(['needs', AGENTS, 'vitals', 'backup', 'ticker']);
    expect(freshSet(agents, { backup: true })).toEqual(['needs', 'art', 'mark', 'vitals', 'backup', 'ticker']);
    // what isn't here is left out: no backup set up, no agents yet
    expect(freshSet(agents, { backup: false })).toEqual(['needs', 'art', 'mark', 'vitals', 'ticker']);
    expect(freshSet([], { backup: false })).toEqual(['needs', 'vitals', 'ticker']);
  });
  it('the + key offers every widget there can be, the ticker last', () => {
    expect(addable(agents, { backup: true }).map((w) => [w.id, w.kind, w.label])).toEqual([
      ['needs', 'needs', 'Needs you'], ['art', 'agent', 'Art’s card'], ['mark', 'agent', 'Mark’s card'],
      ['vitals', 'vitals', 'Vitals'], ['backup', 'backup', 'Backup'], ['ticker', 'ticker', 'Ticker']]);
  });
  it('an id that names nothing here is no widget (an agent gone, a backup not set up)', () => {
    expect(widgetRef('gabe', agents, { backup: true })).toBeNull();
    expect(widgetRef('backup', agents, { backup: false })).toBeNull();
    expect(widgetRef('art', agents, { backup: false })).toEqual({ id: 'art', name: 'Art', kind: 'agent', label: 'Art’s card' });
  });
});
