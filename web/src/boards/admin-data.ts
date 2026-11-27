/** What the bricks for running the household share that is no component: whether the member looking is a
 * household owner, read as the desktop's Household setup reads it (`householdSetup` answers an owner and nobody
 * else). It decides only what a brick offers; loom decides again on every read and every operation. */
import { useDataQuery } from '../data/graphql';

export const householdOwnerQuery = 'query BrickHouseholdOwner { householdSetup { defaultAgent } }';
export function useHouseholdOwner(pause = false): boolean {
  const read = useDataQuery<{ householdSetup: { defaultAgent: string | null } | null }>(householdOwnerQuery, undefined, { keep: true, pause });
  return read.status === 'live' && !!read.data?.householdSetup;
}
/** A record's id that a chip may carry (src/core/boards/bricks/kit.ts, `ref`). */
export const isRef = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,119}$/.test(id);
export const isMember = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(id);
