import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.js';
import { OperationError } from '../operations/index.js';
import { AGENT_NAME } from '../../household.js';
import { HouseholdDatabase } from './document.js';

/** Register an existing portable context. Never bootstrap a creed or mint a token. */
export function addHouseholdAgent(db: Db, home: string, agent: string): string[] {
  if (!db.inTransaction) throw new Error('agent registration requires a transaction');
  if (!AGENT_NAME.test(agent)) throw new OperationError('invalid', 'Invalid agent name');
  const store = new HouseholdDatabase(db), household = store.household(home);
  if (!household) throw new OperationError('unavailable', 'Household has not been imported');
  if (household.agents.includes(agent)) return household.agents;
  // A symlink would let two agents share one private stack. Check the parent
  // too, so a linked agents directory cannot redirect the registration.
  for (const dir of [join(home, 'agents'), join(home, 'agents', agent)]) {
    let real = false;
    try { const stat = lstatSync(dir); real = stat.isDirectory() && !stat.isSymbolicLink(); } catch { /* missing/unreadable context */ }
    if (!real) throw new OperationError('invalid', 'Agent context must already exist as a real directory under agents');
  }
  const agents = [...household.agents, agent];
  store.change(home, raw => { raw.agents = agents; });
  return agents;
}
