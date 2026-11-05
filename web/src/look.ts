// The look (Jonathan, 2026-11-04: "neon noir with a few things borrowed from terminal hud"): Neon Noir, the default and
// dark only, or 000h, light or dark. With light or dark, the ground and sound, it's the person's (Appearance), kept by
// loom so it follows them to every device ("if every device I login I have to go and change the theme, that sucks").
// This device keeps a copy (localStorage) only so its first paint is already right (src/looks/boot.js reads it).
import { createContext, useContext } from 'react';
import type { Ground, Mode } from './views';

export type Look = 'neon' | '000h';
/** The person's Appearance, as loom keeps it (src/ui/sessions.ts): whatever they've chosen, nothing else. */
export type Prefs = { look?: Look; mode?: Mode; ground?: Ground; sound?: boolean; /** pixel faces, where an agent has a sheet (on unless turned off) */ pixel?: boolean; /** haptics, on a phone (on unless turned off) */ haptics?: boolean; /** pinch and double-tap zoom, on a phone (off unless turned on: immersion.ts) */ zoom?: boolean; /** loom's version of them: when they last changed */ at?: number };

const root = () => document.documentElement;

/** What boot.js painted: Neon unless this device's copy says 000h. */
export const shownLook = (): Look => (root().dataset.look === '000h' ? '000h' : 'neon');

/** Wear a look now: its attribute on <html>, and for Neon its stylesheet (boot.js's, or added now). */
export function wearLook(l: Look): void {
  root().dataset.look = l;
  if (l === 'neon' && !document.getElementById('loom-look-neon') && root().dataset.neonCss) {
    const k = document.createElement('link');
    k.rel = 'stylesheet'; k.id = 'loom-look-neon'; k.href = root().dataset.neonCss!;
    k.onload = paintBar;
    document.head.appendChild(k);
  }
  paintBar();
}

/** The browser's own bar matches the page: the look's canvas as it's worn now (Neon's, once its stylesheet is on;
 * 000h's light or dark, whichever the person chose, not only the one the device prefers), else index.html's own pair.
 * Run again when light or dark changes (App.tsx). */
export function paintBar(): void {
  const canvas = getComputedStyle(root()).getPropertyValue('--v-canvas').trim();
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    m.dataset.own ??= m.content;
    m.content = canvas || m.dataset.own;
  }
}

/** This device's copy of a choice, for its next first paint. */
export function keep(key: string, v: string): void {
  try { localStorage.setItem(key, v); } catch { /* private window */ }
}

/** Save a choice as the person's (every device they sign in on gets it): loom's version of them after it, or none if it
 * didn't land. Quietly: this device has the choice either way. */
export async function savePrefs(csrf: string, p: Prefs): Promise<number | undefined> {
  try {
    const r = await fetch('/appearance/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: csrf, ...p }) });
    return r.ok ? ((await r.json()) as { prefs?: Prefs }).prefs?.at : undefined;
  } catch { return undefined; }
}

/** The look being worn, for what draws differently in each (an agent's face: look.ts consumers). */
export const LookContext = createContext<Look>('neon');
export const useLook = () => useContext(LookContext);
/** Whether an agent with a pixel sheet wears it (Appearance's "Pixel faces", the person's; on unless turned off). */
export const PixelContext = createContext(true);

/** loom's six agent marks (src/household.ts MARKS), by their colour: a look can re-point each (neon.css --mark-*). */
const MARKS: Record<string, string> = { '#b8a6ff': 'lilac', '#7a2e4f': 'plum', '#2f6b5a': 'pine', '#e3b341': 'mustard', '#3d5a99': 'denim', '#f09a7a': 'coral' };
/** Which of loom's six marks a colour is, if it is one. */
export const markName = (bg: string): string | undefined => MARKS[bg.toLowerCase()];
/** An agent's mark colour as the look wears it: the look's own for one of loom's marks, else the mark's (000h: always). */
export const markColor = (bg: string): string => (markName(bg) ? `var(--mark-${markName(bg)}, ${bg})` : bg);
