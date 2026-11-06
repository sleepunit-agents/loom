// The widgets the tiled desktop can show (docs/specs/desk-tiling.md, "Widgets: adding, linking, removing"): Needs you,
// each agent's card, Vitals, Backup and the ticker. A widget is known by its id in the address's `w` (`needs`, `vitals`,
// `backup`, `ticker`, or an agent's id); this is what each id is, what a fresh device starts with (today's Home set),
// and what the + key and Find offer.
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

/** A fresh device's widgets: today's Home set (Needs you, each agent's card, Vitals and Backup). */
export function freshSet(agents: Agent[], o: { backup: boolean }): string[] {
  return addable(agents, o).filter((w) => w.kind !== 'ticker').map((w) => w.id);
}
