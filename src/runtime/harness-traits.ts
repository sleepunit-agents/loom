/** What a harness has to say about itself, and the rules about a job's room that every harness applies.
 *
 * This file has no I/O and knows no harness by name. Each adapter (claude-body.ts and its siblings)
 * states its own traits as part of the one Harness it exports, and body-harnesses.ts lists the adapters;
 * the questions asked by name (would this harness refuse the job, may a secret take this name) are
 * answered there. */
import { loomToolsOnly } from '../policy.js';
import type { WorkerRunPolicy } from './worker.js';

export interface HarnessTraits {
  /** The harness always has its own shell and files. It runs only on a machine whose body file gives bodies
   * full reach (`reach: 'all'`), and never a job on anybody else's word (bodyReach). */
  needsFullReach: boolean;
  /** Whether the harness can be told which tools a body is not given. One that cannot never runs a job any denied tool applies to. */
  honoursDeniedTools: boolean;
  /** Whether a name in the body's environment (upper-cased) selects or signs in the account this harness
   * runs on, or is one the adapter sets for the child itself. A startup secret may not take such a name:
   * it would swap the account under the job, or stand in for the adapter's own setting. */
  reservesEnv(name: string, env: NodeJS.ProcessEnv): boolean;
}

/** Whether the job works on anybody else's word: not the agent's own work, not its owners'. The word is
 * loom's (shared-place-mail.ts, jobWord), handed over with the job; nothing here ranks anybody. A room
 * that names no word comes from a loom older than the field and counts as anybody else's. A job with no
 * room at all was not handed out by loom's dispatcher, and nothing is known to hold it by. */
export function hasGuest(policy: WorkerRunPolicy | undefined): boolean {
  return !!policy && loomToolsOnly(policy.word ?? 'others');
}
/** What the body of this job may use: loom's tools only on anybody else's word, whatever the machine gives
 * its bodies; otherwise what the machine's body file says. The one answer for the harness's command line,
 * for whether a harness can run the job at all, and for the body's files. */
export function bodyReach(reach: 'loom' | 'all', policy: WorkerRunPolicy | undefined): 'loom' | 'all' {
  return hasGuest(policy) ? 'loom' : reach;
}
/** A stored denial as the entries it holds. This is the one place that says what a stored denial means.
 *
 * The store takes any one line of 1 to 512 characters (shared-agent-body-policy.ts), and a harness that
 * takes a list of tools reads such a line as several: Claude Code's --disallowedTools is "a comma or
 * space-separated list", with what stands in brackets kept whole (`Bash(git commit:*)`). So entries are
 * parted by commas and white space outside brackets, and nothing else. Everything that asks what a
 * denial covers, and everything handed to a harness, goes through here: a harness is given one entry to
 * an argument and has nothing left to split, so loom and the harness cannot read one line two ways.
 *
 * Forms the store accepts that no harness is known to honour are still read without loss, and count for
 * loom's own rules as far as they can: an unclosed bracket runs to the end of the line as one entry, and a
 * closing bracket with none open is an ordinary character. */
export function denialEntries(stored: string): string[] {
  const entries: string[] = [];
  let entry = '', depth = 0;
  for (const character of stored) {
    if (character === '(') depth++;
    else if (character === ')' && depth > 0) depth--;
    if (depth === 0 && (character === ',' || /\s/.test(character))) { if (entry) entries.push(entry); entry = ''; }
    else entry += character;
  }
  if (entry.trim()) entries.push(entry.trim());
  return entries;
}
/** What this job's body is not given, as entries (denialEntries), each once: every always-denied one, and the
 * guests-only ones when a guest is in the room. */
export function deniedTools(policy: WorkerRunPolicy | undefined): string[] {
  const guest = hasGuest(policy);
  return [...new Set((policy?.deniedTools ?? []).filter(rule => !rule.guestsOnly || guest).flatMap(rule => denialEntries(rule.pattern)))];
}
/** Whether a body has file tools of its own to read a file with: the machine gives its bodies the
 * harness's own tools (`reach: 'all'`), and reading files is not among the tools this job's body is not
 * given. The one rule for everything loom does with a body's files: writing what was sent to it where it
 * can open it (body-attachments.ts) and reading a file it names for a post (body-files.ts). A body held to
 * loom's tools gets neither, by the machine's choice or because its job works on anybody else's word: the
 * caller passes the reach the body really has (bodyReach). Nor does one whose file tools are denied it:
 * loom's own doors are not a way around a denial. */
export function hasFileTools(reach: 'loom' | 'all', policy: WorkerRunPolicy | undefined): boolean {
  return reach === 'all' && !deniedTools(policy).some(pattern => /^Read(\(|$)/.test(pattern.trim()));
}
/** The policy with one more sender nobody vouched for. The body uses it for outside mail that arrived
 * after loom read the room at claim: such a sender was never looked up, so the job's word is anybody else's.
 * loom leaves such mail for the next job (shared-place-mail.ts, lateMailJoins); this is the body's own check. */
export function withUnknownSender(policy: WorkerRunPolicy): WorkerRunPolicy {
  return { ...policy, people: [...policy.people, { kind: 'unknown', person: null, tier: null }], word: 'others' };
}
/** Whether a harness with these traits would refuse the job. `reach` is the machine's, when the caller
 * knows it (the body does, placement does not). A harness that always has its shell cannot be held to
 * loom's tools, so it refuses a job on anybody else's word on any machine: refused, not run open. */
export function refusesJob(traits: HarnessTraits, policy: WorkerRunPolicy | undefined, reach?: 'loom' | 'all'): boolean {
  return traits.needsFullReach && (hasGuest(policy) || reach !== undefined && reach !== 'all') || !traits.honoursDeniedTools && deniedTools(policy).length > 0;
}
