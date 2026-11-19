import type { DockerEngine } from './docker-engine.js';
import { houseCommit, houseStart } from './house-image.js';
import { HOUSE_REPOSITORY } from './house-layout.js';
import { parseProgramResult, programInput, type HouseProgram } from './house-program.js';
import { containerExit } from './job-exit.js';
import { isolatedContainer } from './kit-container.js';
import { canonicalKitImage } from './pinned-program.js';
import type { WorkerAssignment, WorkerBody } from './worker.js';

/** Prepare before requesting private inputs. The worker releases the invocation after the running acknowledgement. */
export function scheduledContainer(
  engine: DockerEngine, job: WorkerAssignment, image: string, program: HouseProgram, signal: AbortSignal,
  options: { runtime?: string; setupTimeoutMs: number; cleanupTimeoutMs: number }, releaseImage: () => void,
): WorkerBody {
  const abort = new AbortController();
  const running = AbortSignal.any([signal, abort.signal]);
  let container: ReturnType<typeof isolatedContainer> | undefined;
  const spawned = (async () => {
    if (job.house.repository !== program.repository || houseCommit(image) !== program.commit)
      throw new Error('Program house does not match its pin');
    const house = await houseStart(engine, image, undefined, AbortSignal.any([running, AbortSignal.timeout(options.setupTimeoutMs)]));
    if (canonicalKitImage(house.id) !== program.image) throw new Error('Program image does not match its pin');
    container = isolatedContainer(engine, {
      ...options, job: job.id, box: job.box, image: program.image,
      entrypoint: HOUSE_REPOSITORY + '/' + program.program, signal: running,
    });
    await container.prepared;
  })();

  let release!: (values: Record<string, string>) => void;
  let reject!: (error: Error) => void;
  const input = new Promise<Record<string, string>>((yes, no) => { release = yes; reject = no; });
  void input.catch(() => {});
  const exited = (async () => {
    await spawned;
    const values = await input;
    const bindings = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Buffer.from(value)]));
    try {
      const { exit, bytes } = await container!.run({
        argv: program.args, secrets: bindings, input: programInput(program, values), timeoutMs: program.timeoutMs,
      });
      try {
        const exitCode = containerExit(exit);
        return { exitCode, logTail: '', signalled: exitCode !== exit,
          ...(exit === 0 && { programResult: parseProgramResult(bytes.toString('utf8'), Object.values(values)) }) };
      } finally { bytes.fill(0); }
    } finally { for (const bytes of Object.values(bindings)) bytes.fill(0); }
  })();
  void exited.catch(() => {});

  let stopping: Promise<void> | undefined, released = false;
  function stop() {
    return stopping ??= Promise.resolve().then(async () => {
      abort.abort();
      reject(new Error('Program stopped'));
      try {
        await spawned.catch(() => {});
        await container?.stop();
      } finally {
        signal.removeEventListener('abort', cancel);
        releaseImage();
      }
    });
  }
  const cancel = () => { void stop().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();

  return { spawned, exited, stop, acceptsBootstrap: false,
    async releaseProgram(values) {
      await spawned;
      if (released || running.aborted) throw new Error('Program input unavailable');
      released = true;
      release(values);
    },
    async release() { throw new Error('Program needs program input'); },
  };
}
