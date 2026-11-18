/** Fixed private child: bootstrap enters on stdin only, after the parent's
 * running ACK. Native execution and mail acceptance happen in this program.
 *
 * Mail order. The body takes its mail and reports it received (the sender sees it delivered), but settles it
 * only after the answer is recorded. A body that dies before answering therefore leaves the mail with its job,
 * and loom tries the work again on the bounded retry chain (Jobs.retry). A body that dies after answering
 * cannot cause a second answer: loom settles the mail in the same write as a thread reply or a bridge reply. */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { workerAssignment } from './worker-http.js';
import { bodyInput, eraseBootstrap, type BodyBootstrap } from './body-bootstrap.js';
import { bodyConversationClient,bodyMailContext } from './conversation-client.js';
import { bodyHarness, harnessCannotRun, harnesses } from './body-harnesses.js';
import { BODY_SCRATCH, HarnessResumeUnavailable, type HarnessRun } from './body-harness.js';
import { bodyProgramTools } from './body-program-tools.js';
import { bodySecretTools } from './body-secret-tools.js';
import { bodyStartupSecrets } from './body-secrets.js';
import {bodyCommandClient} from './body-command-client.js';
import {bodyMemoryIdentity,bodyChannelBrief} from './body-memory-identity.js';
import {saveBodyAttachments} from './body-attachments.js';
import {bodyFileReader} from './body-files.js';
import {bodySessions,type BodySessions} from './body-session.js';
import type { Clock } from '../core/clock.js';
import type { WorkerSchedule, WorkerAssignment } from './worker.js';
import { BODY_EXIT } from './job-exit.js';
import { hasFileTools, withUnknownSender } from './harness-traits.js';
import { REPORT_MS } from './silence.js';
import { BODY_TOKEN } from './body-token.js';
import { BODY_START_BYTES } from './body-input-limit.js';
// `reach` is the machine operator's choice of what a body here may use. 'loom' (the default) gives it loom's
// own tools and nothing else. 'all' gives it the harness's own tools as well: files, shell, the web. Either
// way the household's list of tools an agent's body is not given still applies.
const config = z.object({ command: z.string().min(1), cwd: z.string().min(1), reach: z.enum(['loom', 'all']).default('loom') }).strict();
/** What a body file is, for whoever writes one: the core house's own are held to it. */
export const bodyFileSchema = config;
const envelope = z.object({ job: workerAssignment, build: z.string().min(1),
  bootstrap: z.object({ origin: z.string(), job: z.string(), token: z.string().regex(BODY_TOKEN) }).strict(),
}).strict();
/** What a body reports after a Stop, before leaving with BODY_EXIT.stopped. It does not take the Stop itself:
 * loom takes it when the worker reports that exit (Jobs.finish) and records the job as stopped. */
const left={state:'idle',work:''} as const;
export async function bodyProgram(input: {
  args: readonly string[]; read: (path: string) => Promise<string>;
  stdin: () => Promise<Uint8Array>; env: NodeJS.ProcessEnv; signal: AbortSignal;
  fetch?: typeof fetch; clock?: Clock; schedule?: WorkerSchedule; native?: HarnessRun;
  /** Runs inside the receiving child, before any model sees startup aliases. */
  startup?: (job: WorkerAssignment, bootstrap: BodyBootstrap, signal: AbortSignal) => Promise<void>;
  /** Trusted in-process seam; production reads the current body's declared Memory. */
  loadMemory?: (agent:string,signal:AbortSignal)=>Promise<string|null>;
  /** The same seam for a bridge conversation's kept harness session. */
  sessions?: BodySessions;
  /** The same seam for the files sent with bridge messages. */
  saveAttachments?: typeof saveBodyAttachments;
  /** The same seam for a bridge channel's brief. */
  loadBrief?: typeof bodyChannelBrief;
  error: (text: string) => void;
}): Promise<number> {
  let bytes: Uint8Array | undefined, bootstrap: BodyBootstrap | undefined;
  // The stage the body is in, as the exit code a failure there reports (see job-exit.ts).
  let exit:number=BODY_EXIT.input;
  let tools:Awaited<ReturnType<typeof bodySecretTools>>|undefined;
  let programTools:ReturnType<typeof bodyProgramTools>|undefined;
  let client: ReturnType<typeof bodyConversationClient> | undefined;
  let memoryClient:ReturnType<typeof bodyCommandClient>|undefined,sessionClient:ReturnType<typeof bodyCommandClient>|undefined;
  let keeper:BodySessions|undefined,saved=false;
  const context: string[] = [], incoming:string[]=[];
  const secrets = bodyStartupSecrets(input.env, {fetch:input.fetch,clock:input.clock});
  let pending: Promise<void> | undefined, cancel: (()=>void) | undefined, stopped=false, unavailable=false;
  // Every report to loom goes through here. One that fails after the first exchange is the stage that failed
  // (BODY_EXIT.contact), whatever the body was doing when it reported; the first is BODY_EXIT.report.
  let first=true;
  const tell=(value:Parameters<NonNullable<typeof client>['status']>[0])=>client!.status(value).catch((error:unknown)=>{if(!first)unavailable=true;throw error;});
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
    if (input.signal.aborted || bytes.byteLength > BODY_START_BYTES) throw new Error();
    const parsed = envelope.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    bytes.fill(0); bytes = undefined;
    bootstrap = { ...parsed.bootstrap, token: Buffer.from(parsed.bootstrap.token, 'ascii') };
    const { job } = bodyInput(parsed.job, parsed.build, bootstrap, true);
    exit=BODY_EXIT.assignment;
    const bridge=job.venue==='discord'||job.venue==='slack';
    const background=job.venue==='wake'||job.venue==='handoff';
    if (!Object.hasOwn(harnesses, job.harness) || !job.conversation || (!bridge&&!background&&!job.thread) || (job.venue&&job.venue!=='loom'&&!bridge&&!background) || input.signal.aborted) throw new Error();
    // What the harness would refuse is known from the assignment and this machine's reach. Refuse now, while
    // the mail is unaccepted and stays with the job, rather than after the message has been consumed.
    if (!input.native && harnessCannotRun(job.harness, job.run?.policy, plan.reach)) throw new Error();
    exit=BODY_EXIT.report;
    client = bodyConversationClient({ url: bootstrap.origin, token: parsed.bootstrap.token,
      job: job.id, conversation: job.conversation, signal: input.signal, fetch: input.fetch, clock: input.clock });
    let work='Preparing startup inputs',state:'working'|'waiting'='working',secretWaiting=false;
    let reporting:ReturnType<typeof tell>|undefined;
    const report=()=>reporting??(reporting=tell(secretWaiting&&state!=='waiting'?{state:'waiting',work:'Waiting for a Secret decision'}:{state,work}).finally(()=>{reporting=undefined;}));
    const observe=(value:{stopRequested:boolean})=>{if(value.stopRequested){stopped=true;erase();nativeAbort.abort();}};
    observe(await report());
    if(stopped){await tell(left);return BODY_EXIT.stopped;}
    first=false;
    const beat=()=>{
      if(pending||signal.aborted)return;
      pending=report().then(observe,()=>{erase();nativeAbort.abort();}).finally(()=>{pending=undefined;});
    };
    cancel=input.schedule?input.schedule.every(REPORT_MS,beat):(()=>{const timer=setInterval(beat,REPORT_MS);return()=>clearInterval(timer);})();
    exit=BODY_EXIT.startup;
    await (input.startup ?? secrets.startup)(job, bootstrap, signal);
    if (signal.aborted) throw new Error();
    work='Working on accepted mail';
    exit=BODY_EXIT.mail;
    // A bridge conversation's body continues the session the last one left, when loom hands one over
    // (body-session.ts). It is then told the new mail alone: the session already holds what came before.
    // With none, it starts fresh and is told the conversation's kept history with its mail.
    if(bridge){
      sessionClient=bodyCommandClient({url:bootstrap.origin,token:parsed.bootstrap.token,signal:input.signal,fetch:input.fetch,clock:input.clock});
      keeper=input.sessions??(input.native?undefined:bodySessions(sessionClient,job.harness,input.env));
    }
    const resume=await keeper?.take();
    if(signal.aborted)throw new Error();
    const continued:string[]=[];let oldestErased:string|undefined,fresh=!resume;
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
      // The oldest word handed in that will be erased: a session started from them is counted from then.
      for(const line of item.history)if(line.keepUntil!==null&&(oldestErased===undefined||Date.parse(line.at)<Date.parse(oldestErased)))oldestErased=line.at;
      const words=bodyMailContext(item);if(words!==null){context.push(words);continued.push(item.history.length?bodyMailContext({...item,history:[]})!:words);}
    });
    if (batch.stopRequested) { await retire(); await tell(left); return BODY_EXIT.stopped; }
    if(signal.aborted)throw new Error();
    // Mail with no words left to answer (they expired, or the item is muted) needs no answer: settle it now.
    if (!context.length) {await stopBeats();if(signal.aborted)throw new Error();await client.settle();await tell({state:'idle',work:''});return 0;}
    // A bridge answer is a reply to a message from the bridge. Mail with words and no such message is mail
    // this body cannot answer, so it fails here, as mail, before anything else is loaded for it.
    if(bridge&&!incoming.length)throw new Error();
    exit=BODY_EXIT.identity;
    memoryClient=bodyCommandClient({url:bootstrap.origin,token:parsed.bootstrap.token,signal,fetch:input.fetch,clock:input.clock});
    const memory=await (input.loadMemory?input.loadMemory(job.agent,signal):bodyMemoryIdentity(memoryClient,job.agent,job.venue));
    if(signal.aborted)throw new Error();
    // A bridge channel's rule may name a brief: one more of the agent's role pages, for conversations there.
    // A brief that cannot be found is never a reason to fail: the work goes on and loom tells the owners.
    const brief=bridge?await (input.loadBrief??bodyChannelBrief)(memoryClient,job.agent):null;
    if(signal.aborted)throw new Error();
    // What was sent with the messages, written where a body with file tools can open it (body-attachments.ts).
    // The room as it is now: a sender nobody looked up, who wrote after loom read the room, counts as a guest.
    const policy=lateStranger&&job.run?.policy?withUnknownSender(job.run.policy):job.run?.policy;
    // Files are for a body that has file tools of its own (harness-traits.ts, hasFileTools): what was sent with
    // the messages is written where it can open it, and it may name a file of its own for a post.
    const files=bridge&&hasFileTools(plan.reach,policy);
    const sent=files?await (input.saveAttachments??saveBodyAttachments)(memoryClient,incoming,input.env[BODY_SCRATCH]):null;
    if(signal.aborted)throw new Error();
    if(sent){context.push(sent);continued.push(sent);}
    if(brief)context.unshift(brief);if(memory)context.unshift(memory);
    await pending;
    if(signal.aborted)throw new Error();
    const started = await report();
    if (started.stopRequested) { await retire(); await tell(left); return BODY_EXIT.stopped; }
    const replyTo=incoming.at(-1);
    if(!input.native){
      exit=BODY_EXIT.tools;
      // The last two are read by the tools server and by nothing else this is spread into: with the agent's name the
      // body is served the named tools a terminal has, and `identity` there knows what was handed over above (body-named-tools.ts).
      const rootAccess={url:bootstrap.origin,token:parsed.bootstrap.token,signal,clock:input.clock,fetch:input.fetch,agent:job.agent,identityHanded:!!memory};
      programTools=bodyProgramTools({...rootAccess,
        onStop:()=>observe({stopRequested:true}),onStatus:value=>{state=value.state==='waiting'?'waiting':'working';work=value.work;},
        ...(files?{readFiles:bodyFileReader(plan.cwd,[plan.cwd,input.env[BODY_SCRATCH]])}:{})});
      tools=await bodySecretTools({...rootAccess,job:job.id,conversation:job.conversation,extraTools:programTools.extensions,waiting:value=>{secretWaiting=value;}});
    }
    if(signal.aborted)throw new Error();
    exit=BODY_EXIT.harness;
    const harness = () => input.native ?? bodyHarness(job.harness, { ...plan, env: input.env, mcpConfig:tools?.config,mcpTools:tools?.allowedTools });
    // A second one for the case the session cannot be continued: each takes its own copy of the tools file.
    const native = harness(), afresh = resume ? harness() : undefined;
    tools?.config.fill(0);
    let answer: Awaited<ReturnType<typeof native>> | undefined;
    const room=policy&&job.run&&policy!==job.run.policy?{...job,run:{...job.run,policy}}:job;
    try {
      if(!keeper)answer = await native(room, context.join('\n\n'), signal);
      else try { answer = await native(room, (resume?continued:context).join('\n\n'), signal, resume?{resume}:{}); }
      catch (error) {
        // The harness could not continue the session and did nothing: the same work, afresh, with the history.
        if(!(error instanceof HarnessResumeUnavailable)||!afresh||signal.aborted)throw error;
        answer = await afresh(room, context.join('\n\n'), signal, {});fresh=true;
      }
      if(tools&&!tools.allowsReply(answer.text))throw new Error();
    }
    catch { if(!stopped) throw new Error(); }
    finally { await retire(); }
    if(stopped && !input.signal.aborted) { await tell(left); return BODY_EXIT.stopped; }
    if(unavailable || !answer) throw new Error();
    if (input.signal.aborted) throw new Error();
    exit=BODY_EXIT.record;
    for (const action of answer.actions) await client.turn({ kind: 'action', model: action.model, outcome: 'progressed' });
    if(bridge)await client.bridgeReply({incoming:replyTo!,text:answer.text,model:answer.model,outcome:'progressed'});
    else if(background){
      await client.turn({kind:'reply',model:answer.model,outcome:'progressed'});
    }
    else await client.reply({ clientId: randomUUID(), words: answer.text, model: answer.model, outcome: 'progressed' });
    // The answer is recorded; only now is the mail done. loom has already settled what a thread or bridge reply
    // answers, so this covers the rest: background work, and earlier bridge messages the one reply also answers.
    await client.settle();
    // The answer is on record. Hand loom the session this run left, for the next body of this conversation,
    // and take its files off this machine. Never a reason to fail work that is done.
    // A run that continued a session was told no history, and its start stands. One that started fresh held it.
    try{await keeper?.save(answer.session,fresh?oldestErased:undefined);saved=true;}catch{/* loom sees the kept session is behind the answer */}
    // Reply words have their own storage and retention. Completion metadata must
    // not make a second durable copy, and must preserve any model-authored digest.
    await client.digest({summary:'Completed this stretch of work.',ifAbsent:true});
    await tell({ state: 'idle', work: '' });
    return 0;
  } catch {
    await retire();
    if(stopped&&!unavailable&&!input.signal.aborted&&client){
      try{await tell(left);return BODY_EXIT.stopped;}catch{}
    }
    // A report that failed is why the work was dropped, whichever stage was dropped.
    input.error('Body stopped: invalid input or unavailable execution\n'); return unavailable?BODY_EXIT.contact:exit;
  }
  finally { await retire(); if(!saved){try{keeper?.discard();}catch{}} sessionClient?.close(); client?.close(); input.signal.removeEventListener('abort', erase); }
}
