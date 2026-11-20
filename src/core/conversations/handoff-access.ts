/** Current consent for agent-to-agent work, at enqueue and release. The rule is the household's
 * (policy.ts, mayHandOff), read on current household facts: a removed member or agent consents to nothing. */
import type {DataDatabase} from '../data/database.js';
import {mayHandOff} from '../../policy.js';
import {sharedSharing} from '../../shared-sharing.js';
/** Open work, with no member's private thread around it: the two agents must be peers now. */
export function handoffPeersAssigned(db:DataDatabase,from:string,to:string,project:string|null):boolean {
 return mayHandOff(from,to,project,sharedSharing(db));
}
/** Is this an agent of the household now, and so somebody work can be handed to at all? */
export function handoffTarget(db:DataDatabase,agent:string):boolean {
 return !!sharedSharing(db).agents?.includes(agent);
}
