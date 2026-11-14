import type { Db } from '../db/index.js';
import { HouseholdDatabase } from './document.js';
import type { ContinuitySources } from './backup-continuity.js';

/** Select from the captured app image, never live directory contents or JSON.
 * Every registered agent needs an explicit initialized handle or null absence.
 * Reject extra/duplicate agents too: stale source sets must not silently omit or
 * include a private stack. Connections are borrowed; no opens or migrations. */
export function selectRegisteredContinuity(app: Db, home: string, sources: ContinuitySources): ContinuitySources {
  const household = new HouseholdDatabase(app).household(home);
  if (!household) throw new Error('Backup requires registered household metadata');
  const registered = [...new Set(household.agents)];
  const agents = sources.agents.map(item => ({ ...item }));
  const byAgent = new Map(agents.map(item => [item.agent, item]));
  if (byAgent.size !== agents.length || agents.length !== registered.length
    || registered.some(agent => !byAgent.has(agent))) throw new Error('Backup continuity selection differs from registered household');
  // Undefined is never deliberate absence. Reject before reading any files.
  for (const db of [...agents.flatMap(item => [item.memories, item.notes]), sources.knowledge, sources.people]) {
    if (db !== null && (!db || !db.open || db.inTransaction)) throw new Error('Backup requires initialized continuity handles or explicit absence');
  }
  return { agents: registered.map(agent => byAgent.get(agent)!), knowledge: sources.knowledge, people: sources.people };
}
