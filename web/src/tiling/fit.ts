// What each app declares about the room it can use (docs/specs/desk-tiling.md, "Fit"): a minimum width and height, an
// ideal width, a maximum width (none: it can use any), and whether it wants the big slot. Core apps declare it here, by
// their label (as tint.ts keys apps); a piece's manifest can declare its own (`tab.fit`), which wins. An app with
// neither gets the default row.
//
// No React here, so it's tested on its own (src/ui/desk-tiling-layout.test.ts).

export type Fit = { min: [number, number]; ideal: number; max: number | null; big: boolean; /** why, in a few words (the tiles' reasons) */ why: string };

export const DEFAULT_FIT: Fit = { min: [420, 300], ideal: 720, max: null, big: false, why: 'no fit of its own, so the default' };

const settings: Fit = { min: [360, 280], ideal: 560, max: 680, big: false, why: 'settings' };
const reading: Fit = { min: [420, 300], ideal: 760, max: 1100, big: false, why: 'reading' };

/** The core apps' fit, by label. */
export const FIT: Readonly<Record<string, Fit>> = {
  Comms: { min: [380, 360], ideal: 680, max: 820, big: false, why: 'a thread list and one thread' },
  Tasks: { min: [520, 320], ideal: 1040, max: null, big: true, why: 'a wide list with a detail pane' },
  Changes: { min: [560, 320], ideal: 1100, max: null, big: true, why: 'a wide list with a detail pane' },
  Inbox: { min: [420, 320], ideal: 760, max: 980, big: false, why: 'one column of asks' },
  Boxes: { min: [420, 300], ideal: 820, max: 1200, big: false, why: 'cards with meters' },
  Knowledge: reading, People: reading, Activity: reading,
  Setup: settings, Appearance: settings, Accessibility: settings, Account: settings, Passkeys: settings, Secrets: settings,
};
/** An agent's pages (/a/<agent>/…). */
export const AGENT_FIT: Fit = { min: [420, 360], ideal: 760, max: 1000, big: false, why: 'a page about one agent' };

/** An app's fit: its own (a piece's manifest), else the core table's for its label, else the default. Missing keys of
 * its own fall back to the default row's. */
export function fitFor(label: string, own?: Partial<Omit<Fit, 'why'>>): Fit {
  const base = FIT[label] ?? DEFAULT_FIT;
  if (!own) return base;
  // An ideal left out is the default's, or the min's width when that's wider (vocab.ts tabFit judges it so).
  const min = own.min ?? DEFAULT_FIT.min;
  return { min, ideal: own.ideal ?? Math.max(DEFAULT_FIT.ideal, min[0]), max: own.max === undefined ? DEFAULT_FIT.max : own.max,
    big: own.big ?? DEFAULT_FIT.big, why: 'its own fit' };
}

/** The kinds of widget, and the room each takes (`h`: its height when the widget doesn't say; a measured one wins). */
export type WidgetKind = 'agent' | 'needs' | 'vitals' | 'backup' | 'ticker' | 'box';
export type WidgetFit = { min: [number, number]; ideal: [number, number] };
export const WIDGET_FIT: Readonly<Record<WidgetKind, WidgetFit>> = {
  agent: { min: [260, 108], ideal: [320, 236] },
  needs: { min: [260, 130], ideal: [320, 240] },
  vitals: { min: [260, 110], ideal: [320, 180] },
  backup: { min: [260, 90], ideal: [320, 110] },
  ticker: { min: [260, 44], ideal: [320, 44] },
  box: { min: [260, 110], ideal: [320, 180] },
};
