// A household's pixel icon set (src/icon-set.ts): which icons are line-only, what a manifest may name, what install
// refuses (before it writes anything), and the set in use.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHousehold, type Household } from './household.js';
import { checkIconManifest, iconFile, iconSetOf, installIconSet, lineOnly, setIcon, useIconSet } from './icon-set.js';
import { encodePng } from './png.fixture.js';

/** n opaque pixels, `light` of them at grey `hi`, the rest at grey `lo`. */
function greys(n: number, light: number, hi = 255, lo = 0): Uint8Array {
  const px = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) px.set([i < light ? hi : lo, i < light ? hi : lo, i < light ? hi : lo, 255], i * 4);
  return px;
}
const icon = (w = 32, h = 32, light = 100) => encodePng(w, h, greys(w * h, light), 4);

describe('lineOnly: under 30% of what\'s drawn is light (luminance over 120 of 255)', () => {
  it('turns at 30%', () => {
    expect(lineOnly(greys(1000, 299))).toBe(true);
    expect(lineOnly(greys(1000, 300))).toBe(false);
  });
  it('turns at a luminance of 120', () => {
    // A grey of 120 is dark (not over 120); 121 is light.
    expect(lineOnly(greys(10, 10, 120))).toBe(true);
    expect(lineOnly(greys(10, 10, 121))).toBe(false);
  });
  it('counts only what\'s drawn: transparent pixels are neither', () => {
    const px = greys(10, 4);
    for (let i = 4; i < 10; i++) px[i * 4 + 3] = 0; // 4 drawn, all light
    expect(lineOnly(px)).toBe(false);
    expect(lineOnly(new Uint8Array(40))).toBe(false); // nothing drawn
  });
});

describe('checkIconManifest', () => {
  it('names only plain .png files beside it, for plain app names, and line only among its apps', () => {
    expect(checkIconManifest({ icons: { home: 'home.png' } })).toEqual({ icons: { home: 'home.png' }, line: [] });
    for (const bad of [{ icons: { home: '../household.png' } }, { icons: { home: '/etc/passwd' } }, { icons: { home: 'sub/home.png' } },
      { icons: { Home: 'home.png' } }, { icons: {} }, { icons: { home: 'home.png' }, line: ['inbox'] }, {}, null]) {
      expect(() => checkIconManifest(bad), JSON.stringify(bad)).toThrow(/icon manifest/);
    }
  });
});

describe('install, set and use', () => {
  let h: Household;
  let src: string;
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'loom-iconset-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    h = loadHousehold(home)!;
    src = mkdtempSync(join(tmpdir(), 'loom-iconset-src-'));
  });
  afterEach(() => { rmSync(h.home, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }); });

  it('refuses a well-formed icon that isn\'t 32×32, saying its size, and writes nothing', () => {
    writeFileSync(join(src, 'home.png'), icon());
    writeFileSync(join(src, 'inbox.png'), icon(16, 16));
    expect(() => installIconSet(h, src, 'mine')).toThrow('inbox.png is 16×16; an icon is 32×32');
    expect(existsSync(join(h.home, 'icons'))).toBe(false);
    expect(iconSetOf(h)).toBeUndefined();
  });

  it('refuses a damaged icon by name, not with a stack trace', () => {
    writeFileSync(join(src, 'home.png'), icon().subarray(0, 60));
    expect(() => installIconSet(h, src, 'mine')).toThrow(/^home\.png /);
  });

  it('refuses a PNG not named for an app, rather than dropping it', () => {
    writeFileSync(join(src, 'home.png'), icon());
    writeFileSync(join(src, 'Inbox.png'), icon());
    expect(() => installIconSet(h, src, 'mine')).toThrow(/Inbox\.png isn't named for an app/);
  });

  it('refuses a set named none (that\'s "no set"), and asks for a name it can\'t work out', () => {
    writeFileSync(join(src, 'home.png'), icon());
    expect(() => installIconSet(h, src, 'none')).toThrow(/isn't a set name/);
    expect(() => installIconSet(h, join(src, '.'), '')).toThrow(/--name/);
  });

  it('keeps the bytes it checked, and replaces a set whole', () => {
    writeFileSync(join(src, 'home.png'), icon(32, 32, 1000));
    writeFileSync(join(src, 'inbox.png'), icon(32, 32, 10));
    expect(installIconSet(h, src, 'mine')).toEqual({ set: 'mine', apps: ['home', 'inbox'], line: ['inbox'] });
    expect(readFileSync(iconFile(h, 'home')!).equals(readFileSync(join(src, 'home.png')))).toBe(true);
    rmSync(join(src, 'inbox.png'));
    installIconSet(h, src, 'mine');
    expect(Object.keys(iconSetOf(h)!.apps)).toEqual(['home']);
    expect(existsSync(join(h.home, 'icons', 'mine', 'inbox.png'))).toBe(false);
    expect(existsSync(join(h.home, 'icons', '.mine.old'))).toBe(false);
  });

  it('a manifest\'s own "line" wins over the pixels', () => {
    writeFileSync(join(src, 'h.png'), icon(32, 32, 1000));
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ icons: { home: 'h.png' }, line: ['home'] }));
    expect(installIconSet(h, src, 'mine').line).toEqual(['home']);
  });

  it('swaps one icon, and wears another set or none', () => {
    writeFileSync(join(src, 'home.png'), icon(32, 32, 1000));
    installIconSet(h, src, 'a');
    installIconSet(h, src, 'b');
    expect(iconSetOf(h)?.apps).toEqual({ home: {} });
    const v = iconSetOf(h)!.v;
    expect(setIcon(h, 'tasks', icon(32, 32, 5))).toEqual({ set: 'b', line: true });
    expect(iconSetOf(h)?.apps).toEqual({ home: {}, tasks: { line: true } });
    expect(iconSetOf(h)!.v).not.toBe(v);
    useIconSet(h, 'a');
    expect(iconSetOf(h)?.apps).toEqual({ home: {} });
    useIconSet(h, null);
    expect(iconSetOf(h)).toBeUndefined();
    expect(iconFile(h, 'home')).toBeUndefined();
    expect(() => useIconSet(h, 'nope')).toThrow(/no icon set named nope/);
  });
});
