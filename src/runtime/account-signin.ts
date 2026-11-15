/** Worker-only adapter for the configured private account sign-in program.
 * It receives identity on stdin and acknowledges completion with exactly
 * {"signedIn":true}. Credentials and interactive/provider details stay private.
 * The caller records account/box membership only after this promise succeeds;
 * cancellation/failure cannot prove that an external sign-in was undone. */
import { spawn } from 'node:child_process';
import type { ProcessRuntime, WorkerCommand } from './worker-process.js';

export interface AccountSignInIdentity {
  account: string; owner: string; provider: string; box: string;
}
const native: ProcessRuntime = {
  spawn: plan => {
    if (process.platform === 'win32') throw new Error('Use a POSIX worker');
    return spawn(plan.command, [...plan.args], { cwd: plan.cwd, env: { ...plan.env },
      shell: false, detached: true, stdio: 'pipe' });
  },
  kill: child => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  },
};

/** No implicit retries: a failed read/ack may follow a successful provider
 * action. The deadline includes cleanup, even if the OS never reports close. */
export async function signInAccount(plan: WorkerCommand, identity: AccountSignInIdentity,
  options: { signal: AbortSignal; timeoutMs?: number }, runtime: ProcessRuntime = native): Promise<void> {
  const failed = () => new Error('Account sign-in failed');
  const timeout = options.timeoutMs ?? 300_000;
  const input = { account: identity.account, owner: identity.owner, provider: identity.provider, box: identity.box };
  if (options.signal.aborted || !Number.isInteger(timeout) || timeout <= 0 || timeout > 300_000
    || !plan.command || !plan.cwd || Object.values(input).some(value => typeof value !== 'string' || !value.trim())) throw failed();
  const config = { command: plan.command, args: [...plan.args], cwd: plan.cwd, env: { ...plan.env } };
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<ProcessRuntime['spawn']>;
    let done = false, invalid = false, killed = false, spawned = false, sent = false;
    let exitCode: number | null | undefined;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const kill = () => {
      if (killed || !child?.pid) return;
      killed = true;
      try { runtime.kill(child); } catch { invalid = true; killed = false; }
    };
    const destroy = () => {
      child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
    };
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', cancel);
      chunks.length = 0;
      destroy();
      if (ok && !invalid && !options.signal.aborted) resolve(); else reject(failed());
    };
    const cancel = () => { invalid = true; chunks.length = 0; destroy(); kill(); };
    const timer = setTimeout(() => { cancel(); finish(false); }, timeout);
    options.signal.addEventListener('abort', cancel, { once: true });
    try { child = runtime.spawn(config); }
    catch { finish(false); return; }
    child.stdin.on('error', cancel);
    child.stdout.on('error', cancel);
    child.stderr.on('error', cancel);
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (done || invalid) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 1024) { cancel(); return; }
      chunks.push(Buffer.from(value));
    });
    // Drain and discard stderr. Private sign-in output never becomes job logs.
    child.stderr.on('data', () => {});
    child.once('spawn', () => {
      spawned = true;
      if (done || invalid || options.signal.aborted) { kill(); return; }
      try { child.stdin.end(JSON.stringify(input) + '\n', (error?: Error | null) => {
        if (error) cancel(); else sent = true;
      }); } catch { cancel(); }
    });
    child.once('error', () => { cancel(); finish(false); });
    child.once('exit', code => { exitCode = code; kill(); });
    child.once('close', code => {
      kill();
      // Cleanup can synchronously emit close and then throw. Settle after the
      // kill call returns so that failure cannot be mistaken for success.
      queueMicrotask(() => {
        let ok = false;
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          ok = spawned && sent && (exitCode ?? code) === 0 && value !== null && typeof value === 'object'
            && !Array.isArray(value) && Object.keys(value).length === 1
            && 'signedIn' in value && value.signedIn === true;
        } catch { /* Never include private output or parse errors. */ }
        finish(ok);
      });
    });
    if (invalid || options.signal.aborted) cancel();
  });
}
