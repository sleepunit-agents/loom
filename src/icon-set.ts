/**
 * A household's pixel icons (Jonathan, 2026-11-05): art for its apps' keys, worn in place of the line icons by whoever
 * turns Appearance's "Pixel icons" on. Like a pixel face (household.ts setSprite), it's the household's own art, never
 * loom's: it's installed per household, kept at <home>/icons/<set>/ (manifest.json and its PNGs), and served only to
 * someone signed in. household.json's `icons` names the set in use; none is none.
 *
 *   manifest.json  { "icons": { "home": "home.png", "inbox": "inbox.png", ... }, "line": ["home", ...] }
 *
 * An app is its label in lowercase, dashes for spaces (Home is home, Inbox is inbox). Each icon is a 32×32 PNG (8-bit
 * RGBA, transparent around it): the dock's key wears it at 1×. "line" names the line-only icons (mostly dark ink, little
 * fill): the page inverts those before mapping their colours, so their lines glow on a dark key (web/src/pixel-ramp.ts).
 * Left out, install works it out from each icon's pixels (lineOnly).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { HouseholdError, rawHousehold, writeHouseholdKey, type Household } from './household.js';
import { decodePng, PngError } from './png.js';

export const ICON_APP = /^[a-z][a-z0-9-]{0,40}$/;
export const ICON_SET = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ICON_FILE = /^[a-z0-9][a-z0-9-]{0,40}\.png$/;
const ICON_MAX_BYTES = 64 * 1024;
export const ICON_SIZE = 32;

export type IconManifest = { icons: Record<string, string>; line: string[] };

export const iconsDir = (h: Household) => join(h.home, 'icons');
const setDir = (h: Household, set: string) => join(iconsDir(h), set);

/** The app an icon is for, from a label as the page shows it: Home is home, Find anything is find-anything. */
export const iconApp = (label: string): string => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A manifest as loom keeps it, checked. Throws HouseholdError, saying what's wrong. */
export function checkIconManifest(raw: unknown): IconManifest {
  const bad = (why: string): never => { throw new HouseholdError(`that icon manifest ${why}`); };
  const m = raw as { icons?: unknown; line?: unknown };
  if (!m || typeof m !== 'object' || !m.icons || typeof m.icons !== 'object' || Array.isArray(m.icons)) bad('needs "icons": { "<app>": "<file>.png" }');
  const icons: Record<string, string> = {};
  for (const [app, file] of Object.entries(m.icons as Record<string, unknown>)) {
    if (!ICON_APP.test(app)) bad(`names an app that isn't lowercase letters, digits and dashes (${app})`);
    if (typeof file !== 'string' || !ICON_FILE.test(file)) bad(`gives ${app} a file that isn't a plain .png name (${String(file)})`);
    icons[app] = file as string;
  }
  if (!Object.keys(icons).length) bad('has no icons');
  if (m.line !== undefined && !(Array.isArray(m.line) && m.line.every((a) => typeof a === 'string' && Object.hasOwn(icons, a)))) bad('has a "line" that isn\'t a list of its own apps');
  return { icons, line: [...new Set((m.line as string[] | undefined) ?? [])].sort() };
}

/** Whether an icon is line-only: under 30% of what's drawn is light (luminance over 120 of 255), so it's mostly ink. */
export function lineOnly(rgba: Uint8Array): boolean {
  let drawn = 0, light = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (!rgba[i + 3]) continue;
    drawn++;
    if (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2] > 120) light++;
  }
  return drawn > 0 && light / drawn < 0.3;
}

/** One icon, checked: a PNG, 32×32, 8-bit RGB or RGBA. Its pixels. */
function checkIcon(name: string, png: Buffer): Uint8Array {
  if (png.length > ICON_MAX_BYTES) throw new HouseholdError(`${name} is larger than 64 KB`);
  try {
    const { width, height, rgba } = decodePng(png);
    if (width !== ICON_SIZE || height !== ICON_SIZE) throw new HouseholdError(`${name} is ${width}×${height}; an icon is ${ICON_SIZE}×${ICON_SIZE}`);
    return rgba;
  } catch (err) {
    if (err instanceof PngError) throw new HouseholdError(`${name} ${err.message}`);
    throw err;
  }
}

/**
 * Install a set from a folder and wear it: its manifest.json, or, without one, every <app>.png in it. Each icon is
 * checked before anything is written; the set replaces one of the same name whole. The line-only icons are the
 * manifest's "line" when it gives one, else worked out from the pixels.
 */
export function installIconSet(h: Household, dir: string, name = iconApp(basename(dir))): { set: string; apps: string[]; line: string[] } {
  if (!ICON_SET.test(name)) throw new HouseholdError(`${name} isn't a set name (lowercase letters, digits, dashes)`);
  const mf = join(dir, 'manifest.json');
  let given: IconManifest;
  let lineGiven = false;
  if (existsSync(mf)) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(mf, 'utf-8')); } catch { throw new HouseholdError(`${mf} isn't JSON`); }
    given = checkIconManifest(raw);
    lineGiven = (raw as { line?: unknown }).line !== undefined;
  } else {
    const pngs = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    const icons = Object.fromEntries(pngs.filter((f) => ICON_FILE.test(f) && ICON_APP.test(f.slice(0, -4))).map((f) => [f.slice(0, -4), f]));
    if (!Object.keys(icons).length) throw new HouseholdError(`${dir} has no manifest.json and no <app>.png icons`);
    given = { icons, line: [] };
  }
  const line: string[] = [];
  for (const [app, file] of Object.entries(given.icons)) {
    const p = join(dir, file);
    if (!existsSync(p)) throw new HouseholdError(`the manifest names ${file}, which isn't in ${dir}`);
    const rgba = checkIcon(file, readFileSync(p));
    if (lineGiven ? given.line.includes(app) : lineOnly(rgba)) line.push(app);
  }
  // Written beside the set, then swapped in, so a page never reads half a set.
  mkdirSync(iconsDir(h), { recursive: true, mode: 0o700 });
  const next = join(iconsDir(h), `.${name}.new`);
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { mode: 0o700 });
  for (const file of new Set(Object.values(given.icons))) { copyFileSync(join(dir, file), join(next, file)); }
  const manifest: IconManifest = { icons: given.icons, line: line.sort() };
  writeFileSync(join(next, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  rmSync(setDir(h, name), { recursive: true, force: true });
  renameSync(next, setDir(h, name));
  writeHouseholdKey(h, 'icons', name);
  return { set: name, apps: Object.keys(manifest.icons).sort(), line: manifest.line };
}

/** Give one app of the set in use a new icon (or one it hadn't): checked, its line-only worked out from its pixels. */
export function setIcon(h: Household, app: string, png: Buffer): { set: string; line: boolean } {
  if (!ICON_APP.test(app)) throw new HouseholdError(`${app} isn't an app name (lowercase letters, digits, dashes)`);
  const set = iconSetName(h);
  if (!set) throw new HouseholdError('no icon set is in use: install one first (loom household icons install <dir>)');
  const m = readManifest(h, set);
  const rgba = checkIcon(`${app}.png`, png);
  const file = `${app}.png`;
  writeFileSync(join(setDir(h, set), file), png, { mode: 0o600 });
  const line = lineOnly(rgba);
  const next: IconManifest = { icons: { ...m.icons, [app]: file }, line: [...m.line.filter((a) => a !== app), ...(line ? [app] : [])].sort() };
  writeFileSync(join(setDir(h, set), 'manifest.json'), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return { set, line };
}

/** Wear another installed set, or none. */
export function useIconSet(h: Household, set: string | null): void {
  if (set !== null) {
    if (!ICON_SET.test(set) || !existsSync(join(setDir(h, set), 'manifest.json'))) throw new HouseholdError(`no icon set named ${set} is installed (${installedIconSets(h).join(', ') || 'none'})`);
    readManifest(h, set);
  }
  writeHouseholdKey(h, 'icons', set ?? undefined);
}

/** The sets installed, by name. */
export function installedIconSets(h: Household): string[] {
  try { return readdirSync(iconsDir(h)).filter((d) => ICON_SET.test(d) && existsSync(join(setDir(h, d), 'manifest.json'))).sort(); } catch { return []; }
}

/** household.json's `icons`: the set in use, if it names one. */
export function iconSetName(h: Household): string | undefined {
  const v = rawHousehold(h.home).icons;
  return typeof v === 'string' && ICON_SET.test(v) ? v : undefined;
}

function readManifest(h: Household, set: string): IconManifest {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(setDir(h, set), 'manifest.json'), 'utf-8')); } catch { throw new HouseholdError(`the icon set ${set} has no readable manifest.json`); }
  return checkIconManifest(raw);
}

/**
 * The set in use, as the page needs it: each app it has an icon for (and whether that icon is line-only), and a version
 * that changes when the manifest or an icon does (the page asks with it, so a copy is kept until then). None without one.
 */
export function iconSetOf(h: Household): { set: string; v: string; apps: Record<string, { line?: true }> } | undefined {
  const set = iconSetName(h);
  if (!set) return undefined;
  try {
    const dir = setDir(h, set);
    const raw = readFileSync(join(dir, 'manifest.json'));
    const m = checkIconManifest(JSON.parse(raw.toString('utf-8')));
    const v = createHash('sha256').update(set).update(raw);
    const apps: Record<string, { line?: true }> = {};
    for (const [app, file] of Object.entries(m.icons)) {
      const st = statSync(join(dir, file), { throwIfNoEntry: false });
      if (!st) continue;
      v.update(`${file}:${st.size}:${st.mtimeMs}`);
      apps[app] = m.line.includes(app) ? { line: true } : {};
    }
    return Object.keys(apps).length ? { set, v: v.digest('base64url').slice(0, 10), apps } : undefined;
  } catch { return undefined; }
}

/** The file of an app's icon in the set in use, if it has one. */
export function iconFile(h: Household, app: string): string | undefined {
  const set = iconSetName(h);
  if (!set || !ICON_APP.test(app)) return undefined;
  try {
    const m = readManifest(h, set);
    const file = Object.hasOwn(m.icons, app) ? m.icons[app] : undefined;
    const p = file ? join(setDir(h, set), file) : undefined;
    return p && existsSync(p) ? p : undefined;
  } catch { return undefined; }
}
