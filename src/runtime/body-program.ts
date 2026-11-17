/** Fixed private child: bootstrap enters on stdin only, after the parent's
 * running ACK. Native execution and mail acceptance happen in this program. */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { workerAssignment } from './worker-http.js';
import { bodyInput, eraseBootstrap, type BodyBootstrap } from './body-bootstrap.js';
import { bodyConversationClient,bodyMailContext } from './conversation-client.js';
import { bodyHarnesses } from './body-harnesses.js';
import type { HarnessRun } from './body-harness.js';
import { bodyProgramTools } from './body-program-tools.js';
import { bodySecretTools } from './body-secret-tools.js';
import { bodyStartupSecrets } from './body-secrets.js';
import {bodyCommandClient} from './body-command-client.js';
import {bodyMemoryIdentity} from './body-memory-identity.js';
import type { Clock } from '../core/clock.js';
import type { WorkerSchedule, WorkerAssignment } from './worker.js';
import { BODY_EXIT } from './job-exit.js';
import { harnessCannotRun, withUnknownSender } from './harness-traits.js';
// `reach` is the machine operator's choice of what a body here may use. 'loom' (the default) gives it loom's
// own tools and nothing else. 'all' gives it the harness's own tools as well: files, shell, the web. Either
// way the household's list of tools an agent's body is not given still applies.
const config = z.object({ command: z.string().min(1), cwd: z.string().min(1), reach: z.enum(['loom', 'all']).default('loom') }).strict();
const envelope = z.object({ job: workerAssignment, build: z.string().min(1),
  bootstrap: z.object({ origin: z.string(), job: z.string(), token: z.string().regex(/^body_[a-f0-9]{64}$/) }).strict(),
}).strict();
/** What a body reports after a Stop, before leaving with exit 0. It does not take the Stop itself: loom takes
 * it when it next hears of this job (Jobs.endIfStopAsked) and records the job as stopped. */
const left={state:'idle',work:''} as const;
export async function bodyProgram(input: {
  args: readonly string[]; read: (path: string) => Promise<string>;
  stdin: () => Promise<Uint8Array>; env: NodeJS.ProcessEnv; signal: AbortSignal;
  fetch?: typeof fetch; clock?: Clock; schedule?: WorkerSchedule; native?: HarnessRun;
  /** Runs inside the receiving child, before any model sees startup aliases. */
  startup?: (job: WorkerAssignment, bootstrap: BodyBootstrap, signal: AbortSignal) => Promise<void>;
  /** Trusted in-process seam; production reads the current body's declared Memory. */
  loadMemory?: (agent:string,signal:AbortSignal)=>Promise<string|null>;
  error: (text: string) => void;
}): Promise<number> {
  let bytes: Uint8Array | undefined, bootstrap: BodyBootstrap | undefined;
  // The stage the body is in, as the exit code a failure there reports (see job-exit.ts).
  let exit:number=BODY_EXIT.input;
  let tools:Awaited<ReturnType<typeof bodySecretTools>>|undefined;
  let programTools:ReturnType<typeof bodyProgramTools>|undefined;
  let client: ReturnType<typeof bodyConversationClient> | undefined;
  let memoryClient:ReturnType<typeof bodyCommandClient>|undefined;
  const context: string[] = [], incoming:string[]=[];
  const secrets = bodyStartupSecrets(input.env, {fetch:input.fetch,clock:input.clock});
  let pending: Promise<void> | undefined, cancel: (()=>void) | undefined, stopped=false, unavailable=false;
  const stopBeats=async()=>{cancel?.();cancel=undefined;await pending;};
  const nativeAbort = new AbortController(), signal = AbortSignal.any([input.signal,nativeAbort.signal]);
  const erase = () => { bytes?.fill(0); eraseBootstrap(bootstrap); context.length = 0; incoming.length=0; };
  let retirement:Promise<void>|undefined;
  const retire=()=>retirement??=(async()=>{nativeAbort.abort();memoryClient?.close();programTools?.close();secrets.close();erase();await tools?.close();await stopBeats();})();
  input.signal.addEventListener('abort', erase, { once: true });
  try {
    if (input.args.length !== 1 || input.signal.aborted) throw new Error();
    exit=BODY_EXIT.config;
    const plan = config.parse(JSON.parse(await input.read(input.args[0])));
    exit=BODY_EXIT.envelope;
    bytes = await input.stdin();
    if (input.signal.aborted || bytes.byteLength > 1_048_576) throw new Error();
    const parsed = envelope.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    bytes.fill(0); bytes = undefined;
    bootstrap = { ...parsed.bootstrap, token: Buffer.from(parsed.bootstrap.token, 'ascii') };
    const { job } = bodyInput(parsed.job, parsed.build, bootstrap, true);
    exit=BODY_EXIT.assignment;
    const bridge=job.venue==='discord'||job.venue==='slack';
    const background=job.venue==='wake'||job.venue==='handoff';
    if (!Object.hasOwn(bodyHarnesses, job.harness) || !job.conversation || (!bridge&&!background&&!job.thread) || (job.venue&&job.venue!=='loom'&&!bridge&&!background) || input.signal.aborted) throw new Error();
    // What the harness would refuse is known from the assignment and this machine's reach. Refuse now, while
    // the mail is unaccepted and stays with the job, rather than after the message has been consumed.
    if (!input.native && harnessCannotRun(job.harness, job.run?.policy, plan.reach)) throw new Error();
    exit=BODY_EXIT.report;
    client = bodyConversationClient({ url: bootstrap.origin, token: parsed.bootstrap.token,
      job: job.id, conversation: job.conversation, signal: input.signal, fetch: input.fetch, clock: input.clock });
    let work='Preparing startup inputs',state:'working'|'waiting'='working',secretWaiting=false;
    let reporting:ReturnType<NonNullable<typeof client>['status']>|undefined;
    const report=()=>reporting??(reporting=client!.status(secretWaiting&&state!=='waiting'?{state:'waiting',work:'Waiting for a Secret decision'}:{state,work}).finally(()=>{reporting=undefined;}));
    const observe=(value:{stopRequested:boolean})=>{if(value.stopRequested){stopped=true;erase();nativeAbort.abort();}};
    observe(await report());
    if(stopped){await client.status(left);return 0;}
    const beat=()=>{
      if(pending||signal.aborted)return;
      pending=report().then(observe,()=>{unavailable=true;erase();nativeAbort.abort();}).finally(()=>{pending=undefined;});
    };
    cancel=input.schedule?input.schedule.every(15_000,beat):(()=>{const timer=setInterval(beat,15_000);return()=>clearInterval(timer);})();
    exit=BODY_EXIT.startup;
    await (input.startup ?? secrets.startup)(job, bootstrap, signal);
    if (signal.aborted) throw new Error();
    work='Working on accepted mail';
    exit=BODY_EXIT.mail;
    // loom read who is in the room when it claimed the job. The body takes everything waiting, so mail from
    // outside the household may have arrived since; nobody looked that sender up, so they count as a guest.
    const claimed=job.run?.policy?.mail;let lateStranger=false;
    const batch = await client.takeAndAccept(async (item, sinkSignal) => {
      if (sinkSignal.aborted || signal.aborted) throw new Error();
      // This is the receiving body's context, never a parent's pipe queue.
      if(bridge&&(item.source==='discord'||item.source==='slack')){
        const refs=item.refs.filter(ref=>ref.startsWith('bi:'));
        if(item.source!==job.venue||refs.length!==1)throw new Error();
        incoming.push(refs[0]);
      }
      if(claimed&&item.fromKind==='unknown'&&!claimed.includes(item.id))lateStranger=true;
      const words=bodyMailContext(item);if(words!==null)context.push(words);
    });
    if (batch.stopRequested) { await retire(); await client.status(left); return 0; }
    if(signal.aborted)throw new Error();
    if (!context.length) {await stopBeats();if(signal.aborted)throw new Error();await client.status({state:'idle',work:''});return 0;}
    exit=BODY_EXIT.identity;
    memoryClient=bodyCommandClient({url:bootstrap.origin,token:parsed.bootstrap.token,signal,fetch:input.fetch,clock:input.clock});
    const memory=await (input.loadMemory?input.loadMemory(job.agent,signal):bodyMemoryIdentity(memoryClient,job.agent,job.venue));
    if(signal.aborted)throw new Error();if(memory)context.unshift(memory);
    await pending;
    if(signal.aborted)throw new Error();
    const started = await report();
    if (started.stopRequested) { await retire(); await client.status(left); return 0; }
    if(bridge&&!incoming.length)throw new Error();
    const replyTo=incoming.at(-1);
    if(!input.native){
      const rootAccess={url:bootstrap.origin,token:parsed.bootstrap.token,signal,clock:input.clock,fetch:input.fetch};
      programTools=bodyProgramTools({...rootAccess,
        onStop:()=>observe({stopRequested:true}),onStatus:value=>{state=value.state==='waiting'?'waiting':'working';work=value.work;}});
      tools=await bodySecretTools({...rootAccess,job:job.id,conversation:job.conversation,extraTools:programTools.extensions,waiting:value=>{secretWaiting=value;}});
    }
    if(signal.aborted)throw new Error();
    exit=BODY_EXIT.harness;
    const native = input.native ?? bodyHarnesses[job.harness]({ ...plan, env: input.env, mcpConfig:tools?.config,mcpTools:tools?.allowedTools });
    tools?.config.fill(0);
    let answer: Awaited<ReturnType<typeof native>> | undefined;
    const room=lateStranger&&job.run?.policy?{...job,run:{...job.run,policy:withUnknownSender(job.run.policy)}}:job;
    try { answer = await native(room, context.join('\n\n'), signal);if(tools&&!tools.allowsReply(answer.text))throw new Error(); }
    catch { if(!stopped) throw new Error(); }
    finally { await retire(); }
    if(stopped && !input.signal.aborted) { await client.status(left); return 0; }
    if(unavailable || !answer) throw new Error();
    if (input.signal.aborted) throw new Error();
    exit=BODY_EXIT.record;
    for (const action of answer.actions) await client.turn({ kind: 'action', model: action.model, outcome: 'progressed' });
    if(bridge)await client.bridgeReply({incoming:replyTo!,text:answer.text,model:answer.model,outcome:'progressed'});
    else if(background){
      await client.turn({kind:'reply',model:answer.model,outcome:'progressed'});
    }
    else await client.reply({ clientId: randomUUID(), words: answer.text, model: answer.model, outcome: 'progressed' });
    // Reply words have their own storage and retention. Completion metadata must
    // not make a second durable copy, and must preserve any model-authored digest.
    await client.digest({summary:'Completed this stretch of work.',ifAbsent:true});
    await client.status({ state: 'idle', work: '' });
    return 0;
  } catch {
    await retire();
    if(stopped&&!unavailable&&!input.signal.aborted&&client){
      try{await client.status(left);return 0;}catch{}
    }
    input.error('Body stopped: invalid input or unavailable execution\n'); return exit;
  }
  finally { await retire(); client?.close(); input.signal.removeEventListener('abort', erase); }
}
