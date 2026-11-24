/** The worker's half of a relayed account sign-in. It runs the machine's configured sign-in program for the
 * provider and carries two things between that program and loom: the page to open, out, and the code the
 * page showed, in. It never sees a credential: the provider's own program keeps its own sign-in.
 *
 * The program is given one more argument, a private directory, and speaks through files in it:
 *   link        written by the program: the page a person opens
 *   user-code   written by the program, for a device flow: the short code to enter on that page
 *   code        written here, for a paste-code flow: the code the page showed (the program deletes it)
 *   why         written by the program on failure: one of the words in SIGNIN_PROGRAM_REASONS
 * Exit 0 means the provider's own program says the account is signed in. Anything else means it is not.
 *
 * The code is taken from loom once (see shared-account-signin.ts): this relay picks one take id for the
 * sign-in, takes under it, and reads what it took under it. A lost reply is asked again with the same id.
 * The directory is this OS user's alone and is removed when the sign-in ends; the code is in it, in clear,
 * for as long as the provider's program takes to read it (docs/accepted-tradeoffs.md).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SIGNIN_PROGRAM_REASONS, type SignInReason } from './account-signin-reasons.js';
import { RELAY_MS } from './account-signin-time.js';

export interface SignInRequest { id: string; account: string; owner: string; provider: string }
export interface SignInRemote {
  page(input: { id: string; link: string; userCode?: string }): Promise<void>;
  /** Take the answered code under this take id. Sent again with the same id, it answers the same. */
  take(id: string, take: string): Promise<{ taken: boolean }>;
  /** What this take id took. `answered` with no code: there is a code to take. `stop`: there never will be. */
  code(id: string, take: string): Promise<{ code: string | null; stop: boolean; answered: boolean }>;
  /** `why` is a word; loom shows its own sentence for it. */
  done(input: { id: string; signedIn: boolean; why?: SignInReason }): Promise<void>;
}
export interface SignInProgram { command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }
const first = (path: string, max: number) => { try { return readFileSync(path, 'utf8').split(/\r?\n/)[0].trim().slice(0, max); } catch { return ''; } };

export async function relaySignIn(program: SignInProgram, request: SignInRequest, remote: SignInRemote, options: {
  signal: AbortSignal; timeoutMs?: number; everyMs?: number; spawn?: typeof spawn;
}): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'loom-signin-')), at = (leaf: string) => join(dir, leaf);
  const deadline = Date.now() + (options.timeoutMs ?? RELAY_MS), every = options.everyMs ?? 2_000;
  let child: ChildProcess | undefined, exit: number | null | undefined, signedIn = false, why: SignInReason | undefined;
  const kill = () => { if (child?.pid && exit === undefined) try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
  options.signal.addEventListener('abort', kill, { once: true });
  try {
    child = (options.spawn ?? spawn)(program.command, [...program.args, dir], { cwd: program.cwd, env: { ...program.env }, shell: false, detached: true, stdio: 'ignore' });
    child.once('exit', code => { exit = code; });
    child.once('error', () => { exit = null; });
    const take = randomUUID();
    let shown = false, device = false, typed = false;
    while (exit === undefined && Date.now() < deadline && !options.signal.aborted) {      // bounded by the deadline
      if (!shown && existsSync(at('link'))) {
        await delay(300);                                                                   // let the user code land beside it
        const link = first(at('link'), 4000), userCode = first(at('user-code'), 20);
        if (!/^https:\/\/\S+$/.test(link)) { why = 'no-page'; break; }
        device = !!userCode;
        await remote.page({ id: request.id, link, ...(device ? { userCode } : {}) });
        shown = true;
      } else if (shown && !typed) {
        // A reply that never came is not an answer: the same question goes again at the next turn, under
        // the same take id, so the code is still taken once and still reaches this relay.
        const ask = () => remote.code(request.id, take).catch(() => undefined);
        let answer = await ask();
        if (answer?.answered && !answer.code && !answer.stop) { await remote.take(request.id, take).catch(() => {}); answer = await ask(); }
        if (answer?.stop) { why = 'ended'; break; }
        if (answer?.code && !device) {
          // The provider can open code as soon as that name exists.
          const pending = at('code.pending');
          writeFileSync(pending, answer.code, { mode: 0o600, flag: 'wx' });
          renameSync(pending, at('code'));
          typed = true;
        }
      }
      await delay(every, undefined, { signal: options.signal }).catch(() => {});
    }
    if (options.signal.aborted) { why ??= 'stopped'; kill(); }
    else if (exit === undefined) { why ??= 'timed-out'; kill(); }
    else { signedIn = exit === 0; if (!signedIn && !why) { const said = first(at('why'), 40); why = Object.hasOwn(SIGNIN_PROGRAM_REASONS, said) ? said as SignInReason : 'unsaid'; } }
  } catch { signedIn = false; why ??= 'cannot-run'; kill(); }
  finally { options.signal.removeEventListener('abort', kill); try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing kept that matters */ } }
  // Tell loom even when stopping: a request left open would hold the next one back.
  try { await remote.done({ id: request.id, signedIn, ...(signedIn ? {} : { why: why ?? 'unsaid' }) }); } catch { /* loom ends a silent request by its own clock */ }
  return signedIn;
}
