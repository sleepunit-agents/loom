/** Fixed private child: bootstrap enters on stdin only, after the parent's
 * running ACK. Native execution and mail acceptance happen in this program. */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { workerAssignment } from './worker-http.js';
import { bodyInput, eraseBootstrap, type BodyBootstrap } from './body-bootstrap.js';
import { bodyConversationClient,bodyMailContext } from './conversation-client.js';
import { claudeBody } from './claude-body.js';
import { bodyProgramTools } from './body-program-tools.js';
import { bodySecretTools } from './body-secret-tools.js';
import { bodyStartupSecrets } from './body-secrets.js';
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
  let tools:Awaited<ReturnType<typeof bodySecretTools>>|undefined;
  let programTools:ReturnType<typeof bodyProgramTools>|undefined;
  let client: ReturnType<typeof bodyConversationClient> | undefined;
  const context: string[] = [], incoming:string[]=[];
  const secrets = bodyStartupSecrets(input.env, {fetch:input.fetch,clock:input.clock});
  let pending: Promise<void> | undefined, cancel: (()=>void) | undefined, stopped=false, unavailable=false;
  const stopBeats=async()=>{cancel?.();cancel=undefined;await pending;};
  const nativeAbort = new AbortController(), signal = AbortSignal.any([input.signal,nativeAbort.signal]);
  const erase = () => { bytes?.fill(0); eraseBootstrap(bootstrap); context.length = 0; incoming.length=0; };
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
    const bridge=job.venue==='discord'||job.venue==='slack';
    if (job.harness !== 'claude' || !job.conversation || (!bridge&&!job.thread) || (job.venue&&job.venue!=='loom'&&!bridge) || input.signal.aborted) throw new Error();
    client = bodyConversationClient({ url: bootstrap.origin, token: parsed.bootstrap.token,
      job: job.id, conversation: job.conversation, signal: input.signal, fetch: input.fetch, clock: input.clock });
    let work='Preparing startup inputs',state:'working'|'waiting'='working',secretWaiting=false;
    let reporting:ReturnType<NonNullable<typeof client>['status']>|undefined;
    const report=()=>reporting??(reporting=client!.status(secretWaiting&&state!=='waiting'?{state:'waiting',work:'Waiting for a Secret decision'}:{state,work}).finally(()=>{reporting=undefined;}));
    const observe=(value:{stopRequested:boolean})=>{if(value.stopRequested){stopped=true;erase();nativeAbort.abort();}};
    observe(await report());
    if(stopped){await client.status({state:'idle',work:'',seenStop:true});return 0;}
    const beat=()=>{
      if(pending||signal.aborted)return;
      pending=report().then(observe,()=>{unavailable=true;erase();nativeAbort.abort();}).finally(()=>{pending=undefined;});
    };
    cancel=input.schedule?input.schedule.every(15_000,beat):(()=>{const timer=setInterval(beat,15_000);return()=>clearInterval(timer);})();
    await (input.startup ?? secrets.startup)(job, bootstrap, signal);
    if (signal.aborted) throw new Error();
    work='Working on accepted mail';
    const batch = await client.takeAndAccept(async (item, sinkSignal) => {
      if (sinkSignal.aborted || signal.aborted) throw new Error();
      // This is the receiving body's context, never a parent's pipe queue.
      if(bridge&&(item.source==='discord'||item.source==='slack')){
        const refs=item.refs.filter(ref=>ref.startsWith('bi:'));
        if(item.source!==job.venue||refs.length!==1)throw new Error();
        incoming.push(refs[0]);
      }
      const words=bodyMailContext(item);if(words!==null)context.push(words);
    });
    if (batch.stopRequested) { await stopBeats(); erase(); nativeAbort.abort(); await client.status({ state: 'idle', work: '', seenStop: true }); return 0; }
    if(signal.aborted)throw new Error();
    if (!context.length) {await stopBeats();if(signal.aborted)throw new Error();await client.status({state:'idle',work:''});return 0;}
    await pending;
    if(signal.aborted)throw new Error();
    const started = await report();
    if (started.stopRequested) { await stopBeats(); erase(); nativeAbort.abort(); await client.status({state:'idle',work:'',seenStop:true}); return 0; }
    if(bridge&&!incoming.length)throw new Error();
    if(!input.native){
      const privateRoot={url:bootstrap.origin,token:parsed.bootstrap.token,signal,clock:input.clock,fetch:input.fetch};
      programTools=bodyProgramTools({...privateRoot,
        onStop:()=>observe({stopRequested:true}),onStatus:value=>{if(value.state!=='working'&&value.state!=='waiting')throw new Error();state=value.state;work=value.work;}});
      tools=await bodySecretTools({...privateRoot,job:job.id,conversation:job.conversation,extraTools:programTools.extensions,waiting:value=>{secretWaiting=value;}});
    }
    if(signal.aborted)throw new Error();
    const native = input.native ?? claudeBody({ ...plan, env: input.env, mcpConfig:tools?.config,mcpTools:tools?.allowedTools });
    tools?.config.fill(0);
    let answer: Awaited<ReturnType<typeof native>> | undefined;
    try { answer = await native(job, context.join('\n\n'), signal);if(tools&&!tools.allowsReply(answer.text))throw new Error(); }
    catch { if(!stopped) throw new Error(); }
    finally { nativeAbort.abort(); programTools?.close(); await tools?.close(); await stopBeats(); }
    if(stopped && !input.signal.aborted) { await client.status({state:'idle',work:'',seenStop:true}); return 0; }
    if(unavailable || !answer) throw new Error();
    if (input.signal.aborted) throw new Error();
    for (const action of answer.actions) await client.turn({ kind: 'action', model: action.model, outcome: 'progressed' });
    if(bridge)await client.bridgeReply({incoming:incoming.at(-1)!,text:answer.text,model:answer.model,outcome:'progressed'});
    else await client.reply({ clientId: randomUUID(), words: answer.text, model: answer.model, outcome: 'progressed' });
    await client.status({ state: 'idle', work: '' });
    return 0;
  } catch {
    nativeAbort.abort(); programTools?.close(); secrets.close(); erase();
    await tools?.close(); await stopBeats();
    if(stopped&&!unavailable&&!input.signal.aborted&&client){
      try{await client.status({state:'idle',work:'',seenStop:true});return 0;}catch{}
    }
    input.error('Body stopped: invalid input or unavailable execution\n'); return 1;
  }
  finally { nativeAbort.abort(); programTools?.close(); secrets.close(); erase(); await tools?.close(); await stopBeats(); client?.close(); input.signal.removeEventListener('abort', erase); }
}
