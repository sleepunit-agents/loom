/** What each harness can and cannot do, and the rules about a job's room that every harness applies.
 *
 * This file has no I/O, so both sides read it: loom's placement, which must not send a job to a harness
 * that will refuse it, and the body, which refuses before it accepts any mail. A harness's adapter
 * (claude-body.ts and its siblings) reads its own entry here rather than restating it.
 *
 * To add a harness, add its entry here and its adapter to body-harnesses.ts; a test holds the two lists equal.
 * A harness name with no entry is the machine's own runner: loom knows nothing about it and assumes it able. */
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
export const harnessTraits: Readonly<Record<string, HarnessTraits>> = Object.freeze({
  claude: { needsFullReach: false, honoursDeniedTools: true,
    // Claude Code on a cloud provider signs in with that provider's own variables.
    reservesEnv: (name, env) => /^(?:CLAUDE_|ANTHROPIC_)/.test(name)
      || !!env.CLAUDE_CODE_USE_BEDROCK && /^AWS_/.test(name)
      || !!env.CLAUDE_CODE_USE_VERTEX && /^(?:GOOGLE_|GCLOUD_)/.test(name)
      || !!env.CLAUDE_CODE_USE_FOUNDRY && /^AZURE_/.test(name) },
  codex: { needsFullReach: true, honoursDeniedTools: false, reservesEnv: name => /^(?:CODEX_|OPENAI_)/.test(name) },
  agy: { needsFullReach: true, honoursDeniedTools: false, reservesEnv: name => /^(?:GEMINI_|GOOGLE_|GCLOUD_|ANTIGRAVITY_)/.test(name) },
});

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
/** Whether this harness would refuse the job. `reach` is the machine's, when the caller knows it (the body
 * does, placement does not). */
export function harnessCannotRun(harness: string, policy: WorkerRunPolicy | undefined, reach?: 'loom' | 'all'): boolean {
  if (!Object.hasOwn(harnessTraits, harness)) return false;
  const traits = harnessTraits[harness];
  return traits.needsFullReach && reach !== undefined && reach !== 'all' || !traits.honoursDeniedTools && deniedTools(policy).length > 0;
}
