/** Internal placement only. The calling operation must authorize giving work.
 * No IO, clock reads, implicit local machine, dispatch or credential access.
 */
import { OperationError, type Sharing } from '../../core/index.js';
import { canHost, resolveBox } from './boxes.js';
import type { RuntimeRecords } from './records.js';
import type { runtimeStore } from './store.js';

type Box = RuntimeRecords['box'];
export const PLACE_UP_MS = 2 * 60_000;
export const boxUp = (box: Box, now: number): boolean => box.revokedAt === undefined && !box.reportOnly
  && (box.local || (box.lastSeen !== undefined && now - box.lastSeen <= PLACE_UP_MS));

/** Capability keys match exactly; values match case-insensitive substrings. */
export function meets(facts: readonly string[], need: string): boolean {
  const i = need.indexOf(':');
  const key = i < 0 ? need : need.slice(0, i);
  const value = i < 0 ? undefined : need.slice(i + 1).toLowerCase();
  return facts.some(fact => {
    const split = fact.indexOf(':');
    return (split < 0 ? fact : fact.slice(0, split)) === key
      && (value === undefined || (split >= 0 && fact.slice(split + 1).toLowerCase().includes(value)));
  });
}

/** Preserve ordered failover and waiting for an explicitly selected silent box.
 * Records supplied by the control store are the only source of local identity.
 */
export function placeBody(store: ReturnType<typeof runtimeStore>, sharing: Sharing, agent: string,
  input: { box?: string; needs?: readonly string[] }, now: number): string {
  const needs = input.needs ?? [];
  const boxes = store.ids('box').map(id => store.read('box', id)!);
  const permitted = boxes.filter(box => canHost(box, agent, sharing));
  const fits = (box: Box) => needs.every(need => meets([...box.facts, ...box.labels], need));
  if (input.box !== undefined) {
    const box = resolveBox(store, input.box);
    if (!canHost(box, agent, sharing)) throw new OperationError('conflict', 'That box may not host this agent');
    const missing = needs.filter(need => !meets([...box.facts, ...box.labels], need));
    if (missing.length) throw new OperationError('conflict', `That box does not have ${missing.join(', ')}`);
    return box.id;
  }
  const settings = store.read('settings', agent);
  const preferred = (settings?.boxes ?? []).flatMap(id => permitted.filter(box => box.id === id));
  // Default placement is explicitly registered local metadata, never the loom host.
  const preference = preferred.length ? preferred : permitted.filter(box => box.local);
  const primary = preference.find(box => boxUp(box, now)) ?? preference[0];
  if (!needs.length) {
    if (!primary) throw new OperationError('conflict', 'No preferred or local box may host this agent; name a box');
    return primary.id;
  }
  const matching = permitted.filter(fits);
  if (!matching.length) {
    const nowhere = needs.filter(need => !permitted.some(box => meets([...box.facts, ...box.labels], need)));
    throw new OperationError('conflict', nowhere.length
      ? `No permitted box has ${nowhere.join(', ')}`
      : `No one permitted box has all of ${needs.join(', ')}`);
  }
  const preferredMatch = preference.find(box => fits(box) && boxUp(box, now));
  if (preferredMatch) return preferredMatch.id;
  if (primary && fits(primary)) return primary.id;
  if (matching.length > 1) throw new OperationError('conflict', 'Several permitted boxes meet these needs; name a box');
  return matching[0].id;
}
