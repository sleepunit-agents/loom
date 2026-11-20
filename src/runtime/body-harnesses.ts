/** Every harness a body can run on, by the name a model's role gives it, and the questions loom asks a
 * harness by that name.
 *
 * Adding a harness is one file beside this (see body-harness.ts for what it has to do) and its one line
 * in `harnesses`. The Harness type is what is listed, so an adapter cannot be listed without saying what
 * it can run and which environment names sign it in; placement, the startup-secret check and the body all
 * read those answers from here.
 *
 * A harness name that is not listed is the machine's own runner (a `{job,build}` command): loom knows
 * nothing about it, never refuses on its behalf, and reserves no names for it. */
import { harnessUnavailable, type Harness, type HarnessInput, type HarnessRun } from './body-harness.js';
import { refusesJob } from './harness-traits.js';
import type { WorkerRunPolicy } from './worker.js';
import { agy } from './agy-body.js';
import { claude } from './claude-body.js';
import { codex } from './codex-body.js';

export const harnesses: Readonly<Record<string, Harness>> = Object.freeze({ agy, claude, codex });
const listed = (name: string): Harness | undefined => Object.hasOwn(harnesses, name) ? harnesses[name] : undefined;

/** Whether this harness would refuse the job. Placement asks without `reach` (it does not know the
 * machine's) so that it does not send a job where it can only fail; the body asks with it before it
 * accepts any mail. */
export function harnessCannotRun(name: string, policy: WorkerRunPolicy | undefined, reach?: 'loom' | 'all'): boolean {
  const harness = listed(name);
  return !!harness && refusesJob(harness, policy, reach);
}
/** Whether an environment name (upper-cased) is one this harness signs in with. */
export function harnessReservesEnv(name: string, key: string, env: NodeJS.ProcessEnv): boolean {
  return listed(name)?.reservesEnv(key, env) ?? false;
}
/** The harness's adapter, ready to run one job. The refusal is applied here, once for every adapter: a job
 * for another harness, or one this harness cannot run on this machine, never reaches the adapter. */
export function bodyHarness(name: string, input: HarnessInput): HarnessRun {
  const harness = listed(name);
  if (!harness) throw harnessUnavailable();
  const run = harness.run(input);
  return async (job, words, signal, session) => {
    if (job.harness !== name || refusesJob(harness, job.run?.policy, input.reach ?? 'loom')) throw harnessUnavailable();
    // Only a harness that says where its sessions are is asked to keep one.
    return harness.sessions && session ? run(job, words, signal, session) : run(job, words, signal);
  };
}
/** How the harness keeps sessions, or nothing for a harness that keeps none. */
export function harnessSessions(name: string): Harness['sessions'] {
  return listed(name)?.sessions;
}
/** Remove what a harness leaves outside its body's scratch directory and can only remove itself when it ends
 * normally. The worker calls this with the scratch directory and the body's environment after the body's
 * process group is gone, so a killed body is tidied too. */
export function harnessLeftovers(name: string, scratch: string, env: Readonly<Record<string, string | undefined>>): void {
  listed(name)?.leftovers?.(scratch, env);
}
