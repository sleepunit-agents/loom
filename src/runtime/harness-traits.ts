/** What a harness has to say about itself, and the rules about a job's room that every harness applies.
 *
 * This file has no I/O and knows no harness by name. Each adapter (claude-body.ts and its siblings)
 * states its own traits as part of the one Harness it exports, and body-harnesses.ts lists the adapters;
 * the questions asked by name (would this harness refuse the job, may a secret take this name) are
 * answered there. */
import type { WorkerRunPolicy } from './worker.js';

export interface HarnessTraits {
  /** The harness always has its own shell and files. It runs only on a machine whose body file gives bodies
   * full reach (`reach: 'all'`). */
  needsFullReach: boolean;
  /** Whether the harness can be told which tools a body is not given. One that cannot never runs a job any denied tool applies to. */
  honoursDeniedTools: boolean;
  /** Whether a name in the body's environment (upper-cased) selects or signs in the account this harness
   * runs on. A startup secret may not take such a name: it would swap the account under the job. */
  reservesEnv(name: string, env: NodeJS.ProcessEnv): boolean;
}

/** A guest is a sender from outside the household whom the agent's owner has not placed in the top tier.
 * One guest in a job's room makes the guests-only rules apply to the whole job. */
export function hasGuest(policy: WorkerRunPolicy | undefined): boolean {
  return policy?.people.some(person => person.kind !== 'person' && person.tier !== 3) ?? false;
}
/** The tool patterns this job's body is not given: every always-denied one, and the guests-only ones when a guest is in the room. */
export function deniedTools(policy: WorkerRunPolicy | undefined): string[] {
  const guest = hasGuest(policy);
  return [...new Set((policy?.deniedTools ?? []).filter(rule => !rule.guestsOnly || guest).map(rule => rule.pattern))];
}
/** The policy with one more sender nobody vouched for. The body uses it for outside mail that arrived
 * after loom read the room at claim: such a sender's tier was never looked up, so they count as a guest. */
export function withUnknownSender(policy: WorkerRunPolicy): WorkerRunPolicy {
  return { ...policy, people: [...policy.people, { kind: 'unknown', person: null, tier: null }] };
}
/** Whether a harness with these traits would refuse the job. `reach` is the machine's, when the caller
 * knows it (the body does, placement does not). */
export function refusesJob(traits: HarnessTraits, policy: WorkerRunPolicy | undefined, reach?: 'loom' | 'all'): boolean {
  return traits.needsFullReach && reach !== undefined && reach !== 'all' || !traits.honoursDeniedTools && deniedTools(policy).length > 0;
}
