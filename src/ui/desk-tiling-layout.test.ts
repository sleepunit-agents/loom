// The tiling rule (docs/specs/desk-tiling.md, "The rule", criteria 1 to 9): a pure function, so no browser.
import { describe, it, expect } from 'vitest';
import { admit, capFor, GUTTER, layout, place, promote, railWidth, swap, underMinimum, type AppTile, type Rect } from '../../web/src/tiling/layout';
import { AGENT_FIT, fitFor } from '../../web/src/tiling/fit';

const app = (name: string, pinned = false): AppTile => ({ id: name.toLowerCase(), name, fit: fitFor(name), ...(pinned ? { pinned } : {}) });
const area = (w: number, h: number): Rect => ({ x: 0, y: 0, w, h });
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, A: Rect) => r.x >= A.x && r.y >= A.y && r.x + r.w <= A.x + A.w + 0.001 && r.y + r.h <= A.y + A.h + 0.001;

describe('the tiling rule', () => {
  it('1. one fills, two sit side by side, three put the first on the left and the others stacked', () => {
    const A = area(1920, 890);
    const one = layout([app('Inbox')], A, 1920);
    expect(one.apps.inbox).toEqual(A);
    const two = layout([app('Inbox'), app('Comms')], A, 1920);
    expect(two.apps.inbox.y).toBe(0); expect(two.apps.comms.y).toBe(0);
    expect(two.apps.comms.x - (two.apps.inbox.x + two.apps.inbox.w)).toBe(GUTTER);
    expect(two.apps.inbox.w + GUTTER + two.apps.comms.w).toBe(1920);
    const apps = [app('Tasks'), app('Inbox'), app('Comms')];
    const t = layout(apps, A, 1920);
    expect(t.apps.tasks).toMatchObject({ x: 0, y: 0, h: 890 });
    expect(t.apps.inbox.x).toBe(t.apps.comms.x);
    expect(t.apps.inbox.x).toBe(t.apps.tasks.w + GUTTER);
    expect(t.apps.comms.y).toBe(t.apps.inbox.h + GUTTER);
    for (const a of apps) { expect(t.apps[a.id].w).toBeGreaterThanOrEqual(a.fit.min[0]); expect(t.apps[a.id].h).toBeGreaterThanOrEqual(a.fit.min[1]); }
    // "Widest of the rest" is the largest ideal among them (Inbox's 760), not the first of them (Comms's 680).
    expect(layout([app('Tasks'), app('Comms'), app('Inbox')], A, 1920).apps.tasks.w).toBe(1104);
  });

  it('2. dwindle: at 2560×1300 the fourth app sits beside the third, under the second', () => {
    const l = layout([app('Tasks'), app('Inbox'), app('Comms'), app('Knowledge')], area(2560, 1300), 2560);
    const [second, third, fourth] = [l.apps.inbox, l.apps.comms, l.apps.knowledge];
    expect(third.y).toBe(fourth.y);
    expect(fourth.x).toBe(third.x + third.w + GUTTER);
    expect(third.y).toBe(second.y + second.h + GUTTER);
    expect(third.x).toBe(second.x);
    // Every split is the same step: Comms's share of its own region is from Comms's and Knowledge's ideals.
    const region = third.w + GUTTER + fourth.w;
    expect(third.w).toBe(Math.round((region - GUTTER) * 680 / (680 + 760)));
    // The threshold: wider than 1.15 times its height is side by side, else stacked.
    const side = layout([app('Inbox'), app('Comms')], area(1200, 1000), 1920);
    expect(side.apps.comms.y).toBe(0);
    const stacked = layout([app('Inbox'), app('Comms')], area(1100, 1000), 1920);
    expect(stacked.apps.comms.x).toBe(0);
    expect(stacked.apps.comms.y).toBeGreaterThan(0);
  });

  it('3. fit sets the ratio, and a max stops the first', () => {
    const l = layout([app('Tasks'), app('Comms')], area(1538, 900), 1920);
    expect(l.apps.tasks.w).toBe(Math.round(1528 * 1040 / 1720));
    expect(l.apps.tasks.w).toBe(924);
    expect(l.apps.comms.w).toBe(604);
    const b = layout([app('Boxes'), app('Tasks')], area(3200, 1300), 3200);
    expect(b.apps.boxes.w).toBe(1200);
    expect(b.apps.tasks.w).toBe(3200 - 1200 - GUTTER);
    // The max wins over the 34 percent floor.
    expect(layout([app('Setup'), app('Tasks')], area(3000, 1300), 3000).apps.setup.w).toBe(680);
    // Both capped: the ratio stands.
    const both = layout([app('Comms'), app('Inbox')], area(1810, 900), 1920);
    expect([both.apps.comms.w, both.apps.inbox.w]).toEqual([850, 950]);
    // The 34 percent floor: Setup's raw 607 px is clamped up.
    expect(layout([app('Setup'), app('Changes')], area(1810, 900), 1920).apps.setup.w).toBe(612);
    // The 66 percent ceiling: Changes's raw 66.3 percent (1,193 px) is clamped down to 1,188.
    expect(layout([app('Changes'), app('Setup')], area(1810, 900), 1920).apps.changes.w).toBe(1188);
    // The first has no max and the rest have one: it takes what they can't use.
    const noMax = layout([app('Tasks'), app('Comms')], area(3000, 1300), 3000);
    expect([noMax.apps.tasks.w, noMax.apps.comms.w]).toEqual([2170, 820]);
  });

  it('4. a big app takes the big slot, unless the person made another the big one', () => {
    expect(place([app('Comms')], app('Tasks')).map((a) => a.name)).toEqual(['Tasks', 'Comms']);
    expect(place([app('Tasks')], app('Comms')).map((a) => a.name)).toEqual(['Tasks', 'Comms']);
    const pinned = promote([app('Inbox'), app('Comms')], 'comms');
    expect(pinned.map((a) => [a.name, !!a.pinned])).toEqual([['Comms', true], ['Inbox', false]]);
    expect(place(pinned, app('Tasks')).map((a) => a.name)).toEqual(['Comms', 'Inbox', 'Tasks']);
    // Opened from a tile: right after it; from the agents' rail or Home: last, next to the rail.
    expect(place([app('Inbox'), app('Comms')], app('Tasks'), { tile: 'inbox' }).map((a) => a.name)).toEqual(['Inbox', 'Tasks', 'Comms']);
    expect(place([app('Comms')], app('Tasks'), { rail: true }).map((a) => a.name)).toEqual(['Comms', 'Tasks']);
    // Only one is pinned: making another the big one unpins the first.
    expect(promote(pinned, 'inbox').map((a) => [a.name, !!a.pinned])).toEqual([['Inbox', true], ['Comms', false]]);
    // Swapping a pinned tile out of the big slot unpins it.
    expect(swap(pinned, 0, 1).map((a) => [a.name, !!a.pinned])).toEqual([['Inbox', false], ['Comms', false]]);
  });

  it('5. the agents\' rail is a fixed width beside the apps, by the screen, and none under 1280 (docs/specs/agent-desk.md)', () => {
    expect([1279, 1280, 1439, 1440, 1920, 2560].map(railWidth)).toEqual([0, 296, 296, 320, 320, 320]);
  });

  it('7. too small: the least recently used app goes to the dock, never the one opened, the one it came from, or a pinned one', () => {
    const A = area(1232, 597);
    const used = { tasks: 2, comms: 1 };
    const r = admit([app('Tasks'), app('Comms')], app('Changes'), A, 1280, { usedAt: used });
    expect(r.docked.map((d) => d.app.name)).toEqual(['Comms']);
    expect(r.docked[0].why).toBe('Comms went to the dock to make room for Changes: it would have been under its 360 px minimum height');
    expect(underMinimum(r.apps, A, 1280)).toBeUndefined();
    for (const a of r.apps) { const l = layout(r.apps, A, 1280).apps[a.id]; expect(l.w).toBeGreaterThanOrEqual(a.fit.min[0]); expect(l.h).toBeGreaterThanOrEqual(a.fit.min[1]); }
    // Comms is the one it came from: Tasks goes instead, though Comms was used less recently.
    const from = admit([app('Tasks'), app('Comms')], app('Changes'), A, 1280, { usedAt: used, from: { tile: 'comms' } });
    expect(from.docked.map((d) => d.why)).toEqual(['Tasks went to the dock to make room for Changes: Comms would have been under its 360 px minimum height']);
    // Comms is pinned: Tasks goes.
    const pin = admit(promote([app('Tasks'), app('Comms')], 'comms'), app('Changes'), A, 1280, { usedAt: used });
    expect(pin.docked.map((d) => d.app.name)).toEqual(['Tasks']);
    expect(pin.apps.map((a) => a.name)).toContain('Changes');
  });

  it('8. the cap: a third app at 1279 px sends one to the dock; at 1280 it fits', () => {
    expect([capFor(1279), capFor(1280), capFor(1599), capFor(1600), capFor(2559), capFor(2560)]).toEqual([2, 3, 3, 4, 4, 6]);
    const apps = [app('Inbox'), app('Comms')];
    expect(admit(apps, app('Knowledge'), area(1231, 760), 1279).docked.map((d) => d.why)).toEqual(['Inbox went to the dock to make room for Knowledge: 2 apps is the most this screen holds']);
    expect(admit(apps, app('Knowledge'), area(1232, 760), 1280).docked).toEqual([]);
    const set = ['Appearance', 'Accessibility', 'Profile', 'Passkeys'].map((n) => app(n));
    expect(admit(set.slice(0, 3), app('Passkeys'), area(1551, 1000), 1599).docked.map((d) => d.why)).toEqual(['Appearance went to the dock to make room for Passkeys: 3 apps is the most this screen holds']);
    expect(admit(set.slice(0, 3), app('Passkeys'), area(1552, 1000), 1600).docked).toEqual([]);
    expect(admit(set, app('Secrets'), area(2511, 1300), 2559).docked.map((d) => d.why)).toEqual(['Appearance went to the dock to make room for Secrets: 4 apps is the most this screen holds']);
    expect(admit(set, app('Secrets'), area(2512, 1300), 2560).docked).toEqual([]);
  });

  it('fit: an agent\'s pages, a core app, a piece\'s own and the default', () => {
    expect(AGENT_FIT).toMatchObject({ min: [420, 360], ideal: 760, max: 1000, big: false });
    expect(fitFor('Comms')).toMatchObject({ min: [380, 360], ideal: 680, max: 820, big: false });
    expect(fitFor('Garden')).toMatchObject({ min: [420, 300], ideal: 720, max: null, big: false });
    expect(fitFor('Garden', { ideal: 900, max: 1000 })).toMatchObject({ min: [420, 300], ideal: 900, max: 1000, big: false });
  });

  it('9. deterministic: the same tiles at the same size give the same boxes', () => {
    const apps = [app('Tasks'), app('Comms'), app('Inbox'), app('Knowledge')];
    const first = layout(apps, area(1872, 890), 1920);
    layout([...apps].reverse(), area(1232, 597), 1280);
    expect(layout(apps, area(1872, 890), 1920)).toEqual(first);
  });

  it('17 (the rule half). no two boxes overlap and every box is inside the area', () => {
    for (const [screen, h] of [[1280, 597], [1920, 890]]) {
      const A = area(screen - 20, h);
      for (let n = 1; n <= 4; n++) {
        const apps = [app('Tasks'), app('Comms'), app('Inbox'), app('Knowledge')].slice(0, n);
        const l = layout(apps, A, screen);
        const boxes = Object.values(l.apps);
        for (const b of boxes) expect(inside(b, A), `${screen} ${n}`).toBe(true);
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${screen} ${n} ${i}/${j}`).toBe(false);
      }
    }
  });
});
