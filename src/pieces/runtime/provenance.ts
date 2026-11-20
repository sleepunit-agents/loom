/** Runtime-owned sender history. These helpers are not an authentication boundary:
 * ingestion must derive sender/wake identity from the authenticated owning source.
 * No message words or credentials belong in this metadata.
 */
export type ProvenanceSender =
  | { kind: 'person'; person: string }
  | { kind: 'schedule'; for?: string }
  | { kind: 'agent' | 'unknown' };
export interface Provenance {
  owners: string[];
  people: string[];
  owner: boolean;
  unknown: boolean;
}
export interface ProvenanceRow { key: string; sender: ProvenanceSender }
export const emptyProvenance = (): Provenance => ({ owners: [], people: [], owner: false, unknown: false });
const person = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const limit = 20;

/** Monotonic between owner resets; former owners remain named people. */
export function noteProvenance(before: Provenance, sender: ProvenanceSender, owners: readonly string[]): Provenance {
  const next = structuredClone(before);
  const named = (who: string) => {
    if (!person.test(who)) { next.unknown = true; return; }
    const names = owners.includes(who) ? next.owners : next.people;
    if (owners.includes(who)) next.owner = true;
    if (!names.includes(who)) {
      if (names.length >= limit) next.unknown = true;
      else names.push(who);
    }
  };
  if (sender.kind === 'person') named(sender.person);
  else if (sender.kind === 'schedule' && sender.for === 'owner') next.owner = true;
  else if (sender.kind === 'schedule' && sender.for && person.test(sender.for)) named(sender.for);
  else next.unknown = true;
  return next;
}

export function principalFromHistory(history: Provenance, owners: readonly string[]): { for: string; people: string[] } {
  const people = [...new Set([...history.people, ...history.owners.filter(who => !owners.includes(who))])].sort();
  return { for: history.unknown || people.length > 1 ? '?' : people[0] ?? (history.owner ? 'owner' : '?'), people };
}

/** Scheduled work transfers steering evidence, not only the current display
 * principal. Keep named owners so later demotion can narrow their authority. */
export function principalForWork(history:Provenance,owners:readonly string[]) {
  const principal=principalFromHistory(history,owners);
  return {...principal,people:[...new Set([...principal.people,...history.owners])].sort()};
}

/** The owner can adopt only unplaced sources shown on the original card.
 * In particular, a wake explicitly assigned to someone is never adoptable.
 */
export function resetEligible(row: ProvenanceRow): boolean {
  return row.sender.kind === 'agent' || row.sender.kind === 'unknown'
    || (row.sender.kind === 'schedule' && row.sender.for === '-');
}

/** Clears past history, then recounts the queue as it exists at answer time.
 * The application must separately validate the owning card and household ownership,
 * persist the reset audit, and revoke/drop the body/session that heard the past.
 */
export function resetProvenance(rows: readonly ProvenanceRow[], shown: readonly string[], owners: readonly string[]): Provenance {
  let next = emptyProvenance();
  const counted = new Set(shown);
  for (const row of rows) {
    if (counted.has(row.key) && resetEligible(row)) next.owner = true;
    else next = noteProvenance(next, row.sender, owners);
  }
  return next;
}
