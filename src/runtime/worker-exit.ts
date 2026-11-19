/** How the worker process ends once the worker program has returned. No imports: the entry file loads this
 * before anything that could use a thread.
 *
 * By then the program has ended every body, joined every loop it started and given up its state directory,
 * so nothing of its own is left to do, and a process with nothing left ends by itself with the code it was
 * given. One thing can hold it open: a call to a filesystem that never answers (a watched mount whose
 * server is gone, machine-check.ts) stays out for as long as the kernel keeps it. Such a process does not
 * end by itself, and `process.exit` does not end it either: Node joins its file threads on the way out and
 * waits on the stuck one for ever (checked on Node 22: a process with one such call was still there
 * seconds after `process.exit`, and gone at once on a signal). Only a signal's own default action ends it.
 *
 * So, only when the reader says a call is still out: the process is given a moment to end in the ordinary
 * way, which lets what was written to its output drain, and then signals itself. SIGTERM after a clean stop,
 * which a supervisor reads as stopped in good order. SIGKILL after any other, because the exit code can no
 * longer be delivered and a supervisor must not take a failed worker for a clean one; the worker's own
 * line saying why it stopped has been written by then. With no call out nothing is done here at all. */
export const WORKER_EXIT_GRACE_MS = 2_000;
export function endWorker(code: number, unanswered: number, host: Pick<NodeJS.Process, 'pid' | 'kill' | 'removeAllListeners'> & { exitCode?: NodeJS.Process['exitCode'] } = process): void {
  host.exitCode = code;
  if (unanswered <= 0) return;
  // The timer does not itself keep the process open; the stuck call does.
  setTimeout(() => {
    const signal = code === 0 ? 'SIGTERM' : 'SIGKILL';
    // Nothing of the worker's listens any more; were something left listening, the signal would do nothing.
    host.removeAllListeners(signal);
    host.kill(host.pid, signal);
  }, WORKER_EXIT_GRACE_MS).unref();
}
