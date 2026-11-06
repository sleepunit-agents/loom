// The widgets the tiled desktop can show (docs/specs/desk-tiling.md, "Widgets: adding, linking, removing"): Needs you,
// each agent's card, Vitals, Backup and the ticker. A widget is known by its id in the address's `w` (`needs`, `vitals`,
// `backup`, `ticker`, or an agent's id); this is what each id is, what a fresh device starts with (SEED), and what the
// + key and Find offer.
//
// No React here, so it's tested on its own (src/ui/desk-tiling-layout.test.ts).
import type { WidgetTile } from './layout';

type Agent = { id: string; label: string };
export type WidgetRef = WidgetTile & { /** what the + key and Find call it */ label: string };

const FIXED: Record<string, { name: string; kind: WidgetTile['kind'] }> = {
  needs: { name: 'Needs you', kind: 'needs' },
  vitals: { name: 'Vitals', kind: 'vitals' },
  backup: { name: 'Backup', kind: 'backup' },
  ticker: { name: 'Ticker', kind: 'ticker' },
};

/** A widget by its id, or null when there's no such widget here (an agent that's gone, a backup not set up). */
export function widgetRef(id: string, agents: Agent[], o: { backup: boolean }): WidgetRef | null {
  const f = FIXED[id];
  if (f) return id === 'backup' && !o.backup ? null : { id, name: f.name, kind: f.kind, label: f.name };
  const a = agents.find((x) => x.id === id);
  return a ? { id, name: a.label, kind: 'agent', label: `${a.label}’s card` } : null;
}

/** Everything that can go on the desktop, in the + key's order: Needs you, each agent's card, Vitals, Backup, the ticker. */
export function addable(agents: Agent[], o: { backup: boolean }): WidgetRef[] {
  return ['needs', ...agents.map((a) => a.id), 'vitals', 'backup', 'ticker'].map((id) => widgetRef(id, agents, o)).filter((w): w is WidgetRef => !!w);
}

/**
 * A fresh desktop: what a person sees with no saved layout on this device (a new device, a first visit), so it's never
 * blank (Jonathan, 2026-11-06: "we should seed a user's initial layout with some widgets and so on so it's not just
 * blank"). Change it here: an entry is a widget's id (FIXED's), or AGENTS for each agent's card, in the household's
 * order. One that isn't there (no backup set up, no agents yet) is left out. A saved layout is never touched.
 *
 * No app tile. An Inbox tile when something needs you was weighed and left out: Needs you already shows those asks and
 * answers them where they stand, and an app tile would move every widget to the rail, so the first screen would be
 * busier and say the same thing twice. The widgets on the whole desktop are the calm start; the dock is one press away.
 */
/** In SEED: each agent's card, in the household's order. */
export const AGENTS = '*agents';
/** The seed (above). */
export const SEED: readonly string[] = ['needs', AGENTS, 'vitals', 'backup', 'ticker'];

/** A fresh device's widgets: SEED, each agent's card in place of AGENTS, what isn't here left out. */
export function freshSet(agents: Agent[], o: { backup: boolean }): string[] {
  return SEED.flatMap((id) => (id === AGENTS ? agents.map((a) => a.id) : [id])).filter((id) => widgetRef(id, agents, o));
}
