/** Fixed private child: bootstrap enters on stdin only, after the parent's
 * running ACK. Native execution and mail acceptance happen in this program. */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { workerAssignment } from './worker-http.js';
import { bodyInput, eraseBootstrap, type BodyBootstrap } from './body-bootstrap.js';
import { bodyConversationClient } from './conversation-client.js';
import { claudeBody } from './claude-body.js';
import type { Clock } from '../core/clock.js';
import type { WorkerSchedule, WorkerAssignment } from './worker.js';
const config = z.object({ command: z.string().min(1), cwd: z.string().min(1) }).strict();
const envelope = z.object({ job: workerAssignment, build: z.string().min(1),
  bootstrap: z.object({ origin: z.string(), job: z.string(), token: z.string().regex(/^body_[a-f0-9]{64}$/) }).strict(),
}).strict();
export async function bodyProgram(input: {
  args: readonly string[]; read: (path: string) => Promise<string>;
  stdin: () => Promise<Uint8Array>; env: NodeJS.ProcessEnv; signal: AbortSignal;
  fetch?: typeof fetch; clock?: Clock; schedule?: WorkerSchedule; native?: ReturnType<typeof claudeBody>;
  /** Runs inside the receiving child, before any model sees startup aliases. */
  startup?: (job: WorkerAssignment, bootstrap: BodyBootstrap, signal: AbortSignal) => Promise<void>;
  error: (text: string) => void;
}): Promise<number> {
  let bytes: Uint8Array | undefined, bootstrap: BodyBootstrap | undefined;
  let client: ReturnType<typeof bodyConversationClient> | undefined;
  const context: string[] = [];
  const nativeAbort = new AbortController(), signal = AbortSignal.any([input.signal,nativeAbort.signal]);
  const erase = () => { bytes?.fill(0); eraseBootstrap(bootstrap); context.length = 0; };
  input.signal.addEventListener('abort', erase, { once: true });
  try {
    if (input.args.length !== 1 || input.signal.aborted) throw new Error();
    const plan = config.parse(JSON.parse(await input.read(input.args[0])));
    bytes = await input.stdin();
    if (input.signal.aborted || bytes.byteLength > 1_048_576) throw new Error();
    const parsed = envelope.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    bytes.fill(0); bytes = undefined;
    bootstrap = { ...parsed.bootstrap, token: Buffer.from(parsed.bootstrap.token, 'ascii') };
    const { job } = bodyInput(parsed.job, parsed.build, bootstrap, true);
    if (job.harness !== 'claude' || !job.conversation || !job.thread || input.signal.aborted) throw new Error();
    client = bodyConversationClient({ url: bootstrap.origin, token: parsed.bootstrap.token,
      job: job.id, conversation: job.conversation, signal: input.signal, fetch: input.fetch, clock: input.clock });
    await input.startup?.(job, bootstrap, signal);
    if (input.signal.aborted) throw new Error();
    const batch = await client.takeAndAccept(async (item, signal) => {
      if (signal.aborted || input.signal.aborted) throw new Error();
      // This is the receiving body's context, never a parent's pipe queue.
      if (item.words !== null) context.push(item.words);
    });
    if (batch.stopRequested) { erase(); await client.status({ state: 'idle', work: '', seenStop: true }); return 0; }
    if (!context.length) return 0;
    const report = () => client!.status({ state: 'working', work: 'Working on accepted mail' });
    const started = await report();
    if (started.stopRequested) { erase(); await client.status({state:'idle',work:'',seenStop:true}); return 0; }
    const native = input.native ?? claudeBody({ ...plan, env: input.env });
    let pending: Promise<void> | undefined, stopped = false, unavailable = false;
    const beat = () => {
      if (pending || signal.aborted) return;
      pending = report().then(value => { if(value.stopRequested) { stopped=true; erase(); nativeAbort.abort(); } },
        () => { unavailable=true; erase(); nativeAbort.abort(); }).finally(() => { pending=undefined; });
    };
    const cancel = input.schedule ? input.schedule.every(15_000,beat) : (() => {const timer=setInterval(beat,15_000);return ()=>clearInterval(timer);})();
    let answer: Awaited<ReturnType<typeof native>> | undefined;
    try { answer = await native(job, context.join('\n\n'), signal); }
    catch { if(!stopped) throw new Error(); }
    finally { cancel(); await pending; nativeAbort.abort(); }
    if(stopped && !input.signal.aborted) { await client.status({state:'idle',work:'',seenStop:true}); return 0; }
    if(unavailable || !answer) throw new Error();
    if (input.signal.aborted) throw new Error();
    for (const action of answer.actions) await client.turn({ kind: 'action', model: action.model, outcome: 'progressed' });
    await client.reply({ clientId: randomUUID(), words: answer.text, model: answer.model, outcome: 'progressed' });
    await client.status({ state: 'idle', work: '' });
    return 0;
  } catch { input.error('Body stopped: invalid input or unavailable execution\n'); return 1; }
  finally { nativeAbort.abort(); client?.close(); input.signal.removeEventListener('abort', erase); erase(); }
}
