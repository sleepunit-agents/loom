/** Current shared household facts for the outside permission boundary. */
import { readSharingPolicy,readConversationScope } from './core/data/sharing.js';
import { holds, isHouseholdOwner, maySee, rules, type Sharing, type Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';

/** Removed members are left out, so every rule treats them as nobody; removed agents are left out of `agents`.
 * A removed project is left out too: its links stay in the tables for a restore, and grant nobody anything. */
export function sharedSharing(db: DataDatabase): Sharing {
  return readSharingPolicy(db);
}
/** Is this viewer a household owner now? The one check for every door that needs an owner. */
export function householdOwner(db: DataDatabase, viewer: Viewer): viewer is Extract<Viewer, { kind: 'member' }> {
  return isHouseholdOwner(viewer, sharedSharing(db));
}
/** Is this viewer a member who is in the household now? The one check for what any member may do for themselves. */
export function currentMember(db: DataDatabase, viewer: Viewer): viewer is Extract<Viewer, { kind: 'member' }> {
  return holds(rules.currentMember, viewer, {}, sharedSharing(db));
}
/** The current household owners, by id. Installed services that write to "the owners" read this list. */
export function householdOwners(db: DataDatabase): string[] {
  return Object.entries(sharedSharing(db).members).filter(([, member]) => member.owner).map(([id]) => id).sort();
}
export function canReadSharedConversation(db: DataDatabase, viewer: Viewer, id: string): boolean {
  const row = readConversationScope(db,id);
  return !!row && maySee(viewer, { type: 'conversation', agent: row.agent, project: row.project ?? undefined,
    member: row.member ?? undefined, direct: row.direct }, sharedSharing(db));
}
