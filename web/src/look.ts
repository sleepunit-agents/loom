// The look (Jonathan, 2026-11-04: "neon noir with a few things borrowed from terminal hud"; 2026-11-05: "give them a less
// severe version of neon instead where we can just swap colors"): one structure, Neon's, and a look is only its colours,
// a few corners, its glow and its type (src/looks/looks.css). Neon Noir (the default, dark), Low Light (dark and calm)
// and Daylight (light). With the ground and sound, it's the person's (Appearance), kept by loom so it follows them to
// every device ("if every device I login I have to go and change the theme, that sucks"). This device keeps a copy
// (localStorage) only so its first paint is already right (src/looks/boot.js reads it).
import { createContext } from 'react';
import type { Ground, Mode } from './views';
import type { Follow } from './access';

export type Look = 'neon' | 'lowlight' | 'daylight';
/** The looks, in Appearance's order: each one's name, and whether it's light or dark. */
export const LOOKS: ReadonlyArray<{ look: Look; name: string; mode: 'light' | 'dark' }> = [
  { look: 'neon', name: 'Neon Noir', mode: 'dark' }, { look: 'lowlight', name: 'Low Light', mode: 'dark' }, { look: 'daylight', name: 'Daylight', mode: 'light' },
];
/** A look's light or dark. */
export const modeOf = (l: Look): 'light' | 'dark' => LOOKS.find((x) => x.look === l)?.mode ?? 'dark';
/**
 * A saved look as loom wears it now. 000h was a look of its own until 2026-11-05; whoever chose it gets the look nearest
 * it: Daylight if they'd chosen light, else Low Light. Anything else unknown is Neon Noir. (boot.js does the same, before
 * first paint; src/ui/sessions.ts does too, for what loom keeps.)
 */
export function lookOf(saved: string | null | undefined, mode?: string | null): Look {
  if (saved === 'lowlight' || saved === 'daylight' || saved === 'neon') return saved;
  if (saved === '000h') return mode === 'light' ? 'daylight' : 'lowlight';
  return 'neon';
}

/** The person's Appearance, as loom keeps it (src/ui/sessions.ts): whatever they've chosen, nothing else. `mode` is
 * 000h's light or dark, read only to bring a 000h choice across (lookOf). */
export type Prefs = { look?: Look | '000h'; mode?: Mode; ground?: Ground; sound?: boolean; /** pixel faces, where an agent has a sheet (on unless turned off) */ pixel?: boolean; /** pixel icons, where the household has a set (off unless turned on: app-icon.tsx) */ icons?: boolean; /** haptics, on a phone (on unless turned off) */ haptics?: boolean; /** pinch and double-tap zoom, on a phone (Accessibility; off unless turned on: immersion.ts) */ zoom?: boolean; /** the desktop: tiles (Appearance's "Desktop", docs/specs/desk-tiling.md; off unless turned on) */ tiling?: boolean; /** Reduce motion and Higher contrast (Accessibility: access.ts) */ motion?: Follow; contrast?: Follow; /** loom's version of them: when they last changed */ at?: number };

const root = () => document.documentElement;

/** What boot.js painted. */
export const shownLook = (): Look => lookOf(root().dataset.look);

/** Wear a look now: its attribute on <html>, and its light or dark. */
export function wearLook(l: Look): void {
  root().dataset.look = l;
  root().dataset.mode = modeOf(l);
  paintBar();
}

/** The browser's own bar matches the page: the look's canvas, else index.html's own pair. */
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

/** Whether an agent with a pixel sheet wears it (Appearance's "Pixel faces", the person's; on unless turned off). */
export const PixelContext = createContext(true);

/** loom's six agent marks (src/household.ts MARKS), by their colour: a look can re-point each (looks/looks.css --mark-*). */
const MARKS: Record<string, string> = { '#b8a6ff': 'lilac', '#7a2e4f': 'plum', '#2f6b5a': 'pine', '#e3b341': 'mustard', '#3d5a99': 'denim', '#f09a7a': 'coral' };
/** Which of loom's six marks a colour is, if it is one. */
export const markName = (bg: string): string | undefined => MARKS[bg.toLowerCase()];
/** An agent's mark colour as the look wears it: the look's own for one of loom's marks (looks.css --mark-*), else the mark's. */
export const markColor = (bg: string): string => (markName(bg) ? `var(--mark-${markName(bg)}, ${bg})` : bg);
