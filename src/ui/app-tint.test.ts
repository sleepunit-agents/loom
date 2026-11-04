// @vitest-environment node
/**
 * Each app has one colour (web/src/tint.ts), the same in Places or Setup, in the dock and in its page's header:
 * from its manifest's tab.accent, else loom's table, else its name. Never its place in a grid: before, a tile was
 * coloured `i % 4`, so installing a piece moved every colour after it, and Appearance was pink in Setup's grid but
 * green (olive) in its own header.
 */
import { describe, expect, it } from 'vitest';
// The app's own React (web/node_modules: `npm run build` installs it before `npm test`), the one its components use.
import { createElement as h } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import { APP_TINTS, TINTS, TintContext, nameTint, tintOf, tintsOf } from '../../web/src/tint';
import { placesOf, settingsOf } from '../../web/src/nav';
import { AppTile } from '../../web/src/app-header';
import { SheetView } from '../../web/src/sheets';
import { EnvContext } from '../../web/src/blocks';
import { Dock } from '../../web/src/components/ui/dock';
import { ACCENTS, parseManifest } from './vocab.js';

type P = { label: string; href: string; current: boolean; kind?: 'place' | 'setting'; accent?: string };
const shell = (pieces: P[]) => ({
  owner: 'Jonathan', admin: true, scope: '', household: true, agents: [], asks: 0, home: '/', tab: 'setup',
  core: [{ label: 'Activity', href: '/activity', current: false }, { label: 'Knowledge', href: '/knowledge', current: false }, { label: 'People', href: '/people', current: false }],
  pieces,
});
// The live household's pieces (2026-11-03), as loom sorts them (by label).
const live: P[] = [
  { label: 'Approvals', href: '/p/approvals', current: false, kind: 'setting' }, { label: 'Boxes', href: '/p/runtime', current: false, kind: 'setting' },
  { label: 'Bridges', href: '/p/shuttle', current: false, kind: 'setting' }, { label: 'Clock', href: '/p/clock', current: false, kind: 'setting' },
  { label: 'Machine', href: '/p/machine', current: false, kind: 'setting' }, { label: 'Secrets', href: '/p/secrets', current: false, kind: 'setting' },
  { label: 'Tasks', href: '/p/tasks', current: false, kind: 'place' },
];
// A piece installed ahead of all of them, in both grids.
const withNew = (extra: P[]) => [...extra, ...live].sort((a, b) => a.label.localeCompare(b.label));
const aardvark: P[] = [{ label: 'Aardvark', href: '/p/aardvark', current: false, kind: 'setting' }, { label: 'Abacus', href: '/p/abacus', current: false, kind: 'place' }];

/** Each launch tile's label and data-tint, in the order SheetView draws them. */
function tilesOf(which: 'places' | 'setup', pieces: P[]): Array<[string, string]> {
  const s = shell(pieces);
  const env = { ctx: { source: { id: 'loom', base: '/' }, path: '/', query: {}, csrf: '' }, send: async () => true, go: () => {}, wide: false, withSource: () => env };
  const html = renderToStaticMarkup(h(EnvContext.Provider, { value: env as never },
    h(TintContext.Provider, { value: tintsOf(s.pieces) },
      h(SheetView, { which, chrome: { agent: '', nav: [], clock: '', csrf: '', skipped: [], shell: s } as never, icon: () => 'circle', mode: 'auto', setMode: () => {}, ground: 'none' as never, setGround: () => {}, look: 'neon', setLook: () => {} }))));
  return [...html.matchAll(/data-tint="([a-z]+)".*?<span class="w-full truncate text-sm font-medium">([^<]+)</g)].map((m) => [m[2], m[1]]);
}
const headerTint = (label: string, pieces: P[]) => {
  const html = renderToStaticMarkup(h(TintContext.Provider, { value: tintsOf(pieces) }, h(AppTile, { label, icon: 'circle' })));
  return /data-tint="([a-z]+)"/.exec(html)?.[1];
};

describe("an app's one colour (web/src/tint.ts)", () => {
  it('a tile keeps its colour when another piece is installed before it, in Places and in Setup', () => {
    for (const which of ['places', 'setup'] as const) {
      const before = new Map(tilesOf(which, live));
      const after = new Map(tilesOf(which, withNew(aardvark)));
      expect(before.size).toBeGreaterThan(3);
      // The new piece did land ahead of the others, shifting them along (a position's colour would have changed).
      const at = (m: Map<string, string>, l: string) => [...m.keys()].indexOf(l);
      expect([...before.keys()].some((l) => at(after, l) > at(before, l)), which).toBe(true);
      for (const [label, tint] of before) expect(after.get(label), `${which}: ${label}`).toBe(tint);
    }
  });

  it("an app's header tile is the colour of its tile in the grid (Appearance was pink in Setup, olive in its header)", () => {
    for (const which of ['places', 'setup'] as const) {
      for (const [label, tint] of tilesOf(which, live)) expect(headerTint(label, live), label).toBe(tint);
    }
    expect(tilesOf('setup', live).find(([l]) => l === 'Appearance')?.[1]).toBe(headerTint('Appearance', live));
  });

  it("the dock's tile wears the colour it's given, not its place's", () => {
    const html = renderToStaticMarkup(h(Dock, { variant: 'shelf', items: ['Home', 'Inbox', 'Places', 'More'].reverse().map((label) => ({ value: label, label, icon: null, tint: tintOf(label) })) }));
    expect([...html.matchAll(/data-part="lane"[^>]*data-tint="([a-z]+)"[^>]*>.*?aria-label="([^"]+)"/g)].map((m) => [m[2], m[1]]))
      .toEqual([['More', 'olive'], ['Places', 'yellow'], ['Inbox', 'blue'], ['Home', 'pink']]);
  });

  it("a piece's own tab.accent wins over loom's table and its name; one that isn't a palette name is refused", () => {
    expect(tintsOf([{ label: 'Clock', accent: 'blue' }])('Clock')).toBe('blue');
    expect(tintsOf([{ label: 'Clock' }])('Clock')).toBe(APP_TINTS.Clock);
    expect(tintsOf([{ label: 'Gizmo', accent: 'yellow' }])('Gizmo')).toBe('yellow');
    expect(tintsOf([{ label: 'Gizmo', accent: '#ff0000' }])('Gizmo')).toBe(nameTint('Gizmo'));
    expect(parseManifest({ v: 2, tab: { label: 'x', accent: 'olive' } })).toMatchObject({ tab: { label: 'x', accent: 'olive' } });
    expect(parseManifest({ v: 2, tab: { label: 'x', accent: '#ff0000' } })).toMatch(/tab.accent/);
    expect(parseManifest({ v: 2, tab: { label: 'x', accent: 'green' } })).toMatch(/tab.accent must be one of loom's palette: pink, blue, yellow, olive/);
    // The manifest's palette and the app's are one list.
    expect([...ACCENTS]).toEqual([...TINTS]);
  });

  it('an app loom has no colour for gets a stable one from its name', () => {
    expect(tintOf('Gizmo')).toBe(tintOf('Gizmo'));
    expect(TINTS).toContain(tintOf('Gizmo'));
    expect(tintsOf([])('Gizmo')).toBe(nameTint('Gizmo'));
  });

  it("no two tiles side by side or one above the other share a colour in the common grids (4 columns on a phone, 6 on a desktop)", () => {
    // The dock, Places and Setup as the household has them, and a Setup without the runtime or the bridges. Four colours
    // can't keep every possible set apart (a Setup without only Machine puts two yellows together); none does better here.
    const grids = [
      ['Home', 'Inbox', 'Places', 'More'],
      placesOf(shell(live)).map((p) => p.label),
      settingsOf(shell(live)).map((p) => p.label),
      settingsOf(shell(live.filter((p) => !['Boxes', 'Bridges', 'Machine'].includes(p.label)))).map((p) => p.label),
    ];
    const clashes: string[] = [];
    for (const g of grids) for (const cols of [4, 6]) g.forEach((label, i) => {
      if (i + 1 < g.length && (i + 1) % cols && tintOf(g[i + 1]) === tintOf(label)) clashes.push(`${cols}: ${label} | ${g[i + 1]}`);
      if (i + cols < g.length && tintOf(g[i + cols]) === tintOf(label)) clashes.push(`${cols}: ${label} / ${g[i + cols]}`);
    });
    expect(clashes).toEqual([]);
  });
});
