// An app's one colour (Jonathan, 2026-11-03): the same on its tile in Places or Setup, in the dock, in Find and in
// its page's header, whatever else is installed. It's one of loom's palette (000h's four, --v-pink and the rest), so
// the theme picks the shade for light, dark and each palette, and the ink on it stays readable.
//
// Where it comes from, in order: the piece's own (its manifest's tab.accent, src/ui/vocab.ts), loom's for its own apps
// and the catalog's pieces (APP_TINTS), else one from its name. Never from where it sits in a grid: a tile's colour
// that came from its position (i % 4) changed whenever a piece was installed before it.
import { createContext, useContext } from 'react';

export const TINTS = ['pink', 'blue', 'yellow', 'olive'] as const;
export type Tint = typeof TINTS[number];

/**
 * loom's own apps and the catalog's pieces, by the label they're shown under. Chosen so no two tiles side by side or
 * one above the other share a colour in the common grids, at a phone's four columns and a desktop's six:
 *   dock     Home pink · Inbox blue · Places yellow · More/Setup olive
 *   Places   Activity pink · Knowledge blue · People yellow · Tasks olive
 *   Setup    Approvals pink · Boxes blue · Bridges yellow · Clock olive · Machine blue · Secrets yellow · Members olive
 *            · Pieces yellow · Appearance pink · Accessibility blue
 * and in a Setup without the runtime or the bridges (Approvals, Clock, Secrets, …). Four colours can't keep every set
 * apart; src/ui/app-tint.test.ts checks these. A runtime's pages share its colour (Boxes, Houses, Machine).
 */
export const APP_TINTS: Readonly<Record<string, Tint>> = {
  // The shell
  Home: 'pink', Today: 'pink', Inbox: 'blue', Places: 'yellow', Setup: 'olive', More: 'olive', Find: 'blue',
  Account: 'pink', Passkeys: 'olive',
  // loom's own places
  Activity: 'pink', Knowledge: 'blue', People: 'yellow', Mind: 'blue', Projects: 'olive',
  // Setup's own
  Members: 'olive', Pieces: 'yellow', Appearance: 'pink', Accessibility: 'blue',
  // The catalog's pieces (assets/pieces.json), by their tabs' labels
  Tasks: 'olive', Approvals: 'pink', Boxes: 'blue', Houses: 'blue', Machine: 'blue', Bridges: 'yellow', Clock: 'olive',
  Secrets: 'yellow', Subscriptions: 'olive', Fuel: 'yellow', Discord: 'blue', Slack: 'pink',
};

/** A colour from a name alone (a piece that names none and isn't loom's): the same name, the same colour. */
export const nameTint = (s: string): Tint => TINTS[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length];

/** loom's colour for an app's label: its fixed one, else its name's. */
export const tintOf = (label: string): Tint => APP_TINTS[label] ?? nameTint(label);

const isTint = (v: unknown): v is Tint => (TINTS as readonly string[]).includes(v as string);

/** The household's resolver: each installed piece's own accent (tab.accent) first, then tintOf. */
export function tintsOf(pieces: ReadonlyArray<{ label: string; accent?: string }> | undefined): (label: string) => Tint {
  const own = new Map((pieces ?? []).filter((p) => isTint(p.accent)).map((p) => [p.label, p.accent as Tint]));
  return (label: string) => own.get(label) ?? tintOf(label);
}

/** The resolver for what's drawn now (App.tsx provides the household's); outside it, loom's own. */
export const TintContext = createContext<(label: string) => Tint>(tintOf);
export const useTint = () => useContext(TintContext);
