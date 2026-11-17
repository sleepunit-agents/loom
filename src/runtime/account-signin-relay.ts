/** The worker's half of a relayed account sign-in. It runs the machine's configured sign-in program for the
 * provider and carries two things between that program and loom: the page to open, out, and the code the
 * page showed, in. It never sees a credential: the provider's own program keeps its own sign-in.
 *
 * The program is given one more argument, a private directory, and speaks through files in it:
 *   link        written by the program: the page a person opens
 *   user-code   written by the program, for a device flow: the short code to enter on that page
 *   code        written here, for a paste-code flow: the code the page showed (the program deletes it)
 *   why         written by the program on failure: one of the words in SIGNIN_REASONS
 * Exit 0 means the provider's own program says the account is signed in. Anything else means it is not.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface SignInRequest { id: string; account: string; owner: string; provider: string }
export interface SignInRemote {
  page(input: { id: string; link: string; userCode?: string }): Promise<void>;
  code(id: string): Promise<{ code: string | null; stop: boolean }>;
  done(input: { id: string; signedIn: boolean; why?: string }): Promise<void>;
}
export interface SignInProgram { command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }
/** Longer than the provider's page and code last, shorter than loom keeps the request open. */
export const RELAY_MS = 15 * 60_000;
/** What a sign-in program may say about a failure: one of these words, alone on the first line of `why`.
 * Loom shows its own sentence for the word. The program's own text is never carried, because whatever a
 * provider's program prints could repeat the code or a token, and this text reaches a database row and
 * the owner's inbox. */
export const SIGNIN_REASONS: Readonly<Record<string, string>> = Object.freeze({
  refused: 'The provider refused the sign-in',
  'wrong-code': 'The provider did not accept the code',
  expired: 'The page or the code ran out before the sign-in finished',
  unreachable: 'The provider could not be reached from this machine',
  'not-installed': 'The provider\'s program is not installed on this machine',
});
const UNSAID = 'The provider\'s program says the account is not signed in';
const first = (path: string, max: number) => { try { return readFileSync(path, 'utf8').split(/\r?\n/)[0].trim().slice(0, max); } catch { return ''; } };

export async function relaySignIn(program: SignInProgram, request: SignInRequest, remote: SignInRemote, options: {
  signal: AbortSignal; timeoutMs?: number; everyMs?: number; spawn?: typeof spawn;
}): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'loom-signin-')), at = (leaf: string) => join(dir, leaf);
  const deadline = Date.now() + (options.timeoutMs ?? RELAY_MS), every = options.everyMs ?? 2_000;
  let child: ChildProcess | undefined, exit: number | null | undefined, signedIn = false, why = '';
  const kill = () => { if (child?.pid && exit === undefined) try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
  options.signal.addEventListener('abort', kill, { once: true });
  try {
    child = (options.spawn ?? spawn)(program.command, [...program.args, dir], { cwd: program.cwd, env: { ...program.env }, shell: false, detached: true, stdio: 'ignore' });
    child.once('exit', code => { exit = code; });
    child.once('error', () => { exit = null; });
    let shown = false, device = false, typed = false;
    while (exit === undefined && Date.now() < deadline && !options.signal.aborted) {      // bounded by the deadline
      if (!shown && existsSync(at('link'))) {
        await delay(300);                                                                   // let the user code land beside it
        const link = first(at('link'), 4000), userCode = first(at('user-code'), 20);
        if (!/^https:\/\/\S+$/.test(link)) { why = 'The sign-in program gave no usable page'; break; }
        device = !!userCode;
        await remote.page({ id: request.id, link, ...(device ? { userCode } : {}) });
        shown = true;
      } else if (shown && !typed) {
        const answer = await remote.code(request.id);
        if (answer.stop) { why = 'The sign-in was ended before it finished'; break; }
        if (answer.code && !device) { writeFileSync(at('code'), answer.code, { mode: 0o600 }); typed = true; }
      }
      await delay(every, undefined, { signal: options.signal }).catch(() => {});
    }
    if (options.signal.aborted) { if (!why) why = 'The worker stopped'; kill(); }
    else if (exit === undefined) { if (!why) why = 'Nobody finished the sign-in in time'; kill(); }
    else { signedIn = exit === 0; if (!signedIn && !why) { const said = first(at('why'), 40); why = Object.hasOwn(SIGNIN_REASONS, said) ? SIGNIN_REASONS[said] : UNSAID; } }
  } catch { signedIn = false; if (!why) why = 'The sign-in could not be run on this machine'; kill(); }
  finally { options.signal.removeEventListener('abort', kill); try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing kept that matters */ } }
  // Tell loom even when stopping: a request left open would hold the next one back.
  try { await remote.done({ id: request.id, signedIn, ...(signedIn ? {} : { why }) }); } catch { /* loom ends a silent request by its own clock */ }
  return signedIn;
}
