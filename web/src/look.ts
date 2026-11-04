// The look (Jonathan, 2026-11-04: "neon noir with a few things borrowed from terminal hud"): Neon Noir, the default and
// dark only, or 000h, light or dark. With light or dark, the ground and sound, it's the person's (Appearance), kept by
// loom so it follows them to every device ("if every device I login I have to go and change the theme, that sucks").
// This device keeps a copy (localStorage) only so its first paint is already right (src/looks/boot.js reads it).
import type { Ground, Mode } from './views';

export type Look = 'neon' | '000h';
/** The person's Appearance, as loom keeps it (src/ui/sessions.ts): whatever they've chosen, nothing else. */
export type Prefs = { look?: Look; mode?: Mode; ground?: Ground; sound?: boolean; /** loom's version of them: when they last changed */ at?: number };

const root = () => document.documentElement;

/** What boot.js painted: Neon unless this device's copy says 000h. */
export const shownLook = (): Look => (root().dataset.look === '000h' ? '000h' : 'neon');

/** Wear a look now: its attribute on <html>, and for Neon its stylesheet (boot.js's, or added now). */
export function wearLook(l: Look): void {
  root().dataset.look = l;
  // The browser's own bar matches the page: Neon's canvas, else index.html's own pair (000h's paper and ink).
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    m.dataset.own ??= m.content;
    m.content = l === 'neon' ? '#07070C' : m.dataset.own;
  }
  if (l === 'neon' && !document.getElementById('loom-look-neon') && root().dataset.neonCss) {
    const k = document.createElement('link');
    k.rel = 'stylesheet'; k.id = 'loom-look-neon'; k.href = root().dataset.neonCss!;
    document.head.appendChild(k);
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
