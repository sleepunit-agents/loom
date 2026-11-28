import {pairEvents} from './pair-events.js';
import {PAIR_THREAD} from './pair-thread.js';
import {boardsMail} from '../core/boards/brief.js';
import {cleanLineOf} from '../core/line-name.js';
/** Fixed private child: bootstrap enters on stdin only, after the parent's
 * running ACK. Native execution and mail acceptance happen in this program.
 *
 * Mail order. The body takes its mail and reports it received (the sender sees it delivered), but settles it
 * only after the answer is recorded. A body that dies before answering therefore leaves the mail with its job,
 * and loom tries the work again on the bounded retry chain (Jobs.retry). A body that dies after answering
 * cannot cause a second answer: loom settles the mail in the same write as a thread reply or a bridge reply. */
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { workerAssignment } from './worker-http.js';
import { bodyInput, eraseBootstrap, type BodyBootstrap } from './body-bootstrap.js';
import { bodyConversationClient,bodyMailContext } from './conversation-client.js';
import { omittedWakeTools, type OmittedWakeTools } from './wake-tool-profiles.js';
import { bodyHarness, harnessCannotRun, harnesses } from './body-harnesses.js';
import { BODY_OWN_HARNESS, BODY_SCRATCH, harnessTools, HarnessFailed, HarnessResumeUnavailable, type HarnessRun } from './body-harness.js';
import { failureLine, failureWords, type JobFailure } from './job-failure.js';
import { readFileSync } from 'node:fs';
import {kitReasons,kitUnavailableList,type KitUnavailable} from './kit-availability.js';
import {bodyKitTools,KIT_SOCKET} from './body-kit-tools.js';
import {KitCapacity} from './kit-refused.js';
import { mayAttachNoteFile,mayReadNoteFile } from './house-note-request.js';
import { bodyProgramTools } from './body-program-tools.js';
import { frozenReviewCwd } from './review-cwd.js';
import { bodySecretTools } from './body-secret-tools.js';
import { bodyStartupSecrets } from './body-secrets.js';
import {BodyJobEnded} from './body-job-ended.js';
import {BodyContactExpired,BODY_CONTACT_MESSAGE} from './body-contact.js';
import {bodyCommandClient} from './body-command-client.js';
import {bodyMemoryIdentity,bodyChannelBrief} from './body-memory-identity.js';
import {discordAttachmentLabels} from '../pieces/bridges/discord-link.js';
import {receiveChatFiles,saveBodyAttachments,showBodyAttachments} from './body-attachments.js';
import {bodyFileReader,bodyNoteFileReader} from './body-files.js';
import {bodySessions,type BodySessions} from './body-session.js';
import { usageReport, type UsageReport } from './usage-report.js';
import type { Clock } from '../core/clock.js';
import type { WorkerSchedule, WorkerAssignment } from './worker.js';
import { BODY_EXIT } from './job-exit.js';
import { deniedTools, bodyReach, hasFileTools, hasGuest, withUnknownSender, workingFor } from './harness-traits.js';
import { REPORT_MS } from './silence.js';
import {SESSION_BYTES,SESSION_HISTORY_KEYS} from '../core/conversations/session-limit.js';
import {threadRunKey} from '../core/conversations/history-context.js';
import { BODY_TOKEN } from './body-token.js';
import { BODY_START_BYTES } from './body-input-limit.js';
// `reach` is the machine operator's choice of what a body here may use. 'loom' (the default) gives it loom's
// own tools and nothing else. 'all' gives it the harness's own tools as well: files, shell, the web. Either
// way the household's list of tools an agent's body is not given still applies. And whatever is written here,
// a job on anybody else's word runs with loom's tools only (harness-traits.ts, bodyReach).
const config = z.object({ command: z.string().min(1), cwd: z.string().min(1), reach: z.enum(['loom', 'all']).default('loom') }).strict();
/** What a body file is, for whoever writes one: the core house's own are held to it. */
export const bodyFileSchema = config;
const envelope = z.object({ kitSocket:z.literal(true).optional(), kitUnavailable:kitUnavailableList.optional(), kitReportFailed:z.literal(true).optional(), job: workerAssignment, build: z.string().min(1),
  bootstrap: z.object({ origin: z.string(), job: z.string(), token: z.string().regex(BODY_TOKEN) }).strict(),
}).strict();
/** What a body reports after a Stop, before leaving with BODY_EXIT.stopped. It does not take the Stop itself:
 * loom takes it when the worker reports that exit (Jobs.finish) and records the job as stopped. */
const left={state:'idle',work:''} as const;
/** A handed-off session's own words and reasoning, as the body keeps them (docs/specs/boards.md, "A session's steps"):
 * one step's text is cut at TRACE_TEXT_STEP_MAX characters and says so; one job keeps TRACE_TEXT_JOB_MAX characters
 * of them in all, and then one step in loom's words says the rest is not kept. Tool steps keep their own bound
 * (16,000 characters a step) and are not counted against these. */
export const TRACE_TEXT_STEP_MAX = 8_000;
export const TRACE_TEXT_JOB_MAX = 200_000;
export const TRACE_TEXT_CUT = '\n\n[Cut here: loom keeps 8,000 characters of one step]';
export const TRACE_TEXT_FULL = 'This session\'s words and reasoning reached 200,000 characters, the most loom keeps for one job. Later words and reasoning are not recorded; tool steps still are, and the work itself is not affected.';
export async function bodyProgram(input: {
  args: readonly string[]; read: (path: string) => Promise<string>;
  stdin: () => Promise<Uint8Array>; env: NodeJS.ProcessEnv; signal: AbortSignal;
  fetch?: typeof fetch; clock?: Clock; schedule?: WorkerSchedule; native?: HarnessRun;
  /** Runs inside the receiving child, before any model sees startup aliases. */
  startup?: (job: WorkerAssignment, bootstrap: BodyBootstrap, signal: AbortSignal) => Promise<void>;
  /** Trusted in-process seam; production reads the current body's declared Memory. */
  loadMemory?: (agent:string,signal:AbortSignal)=>Promise<string|null>;
  /** The same seam for a conversation's kept harness session. */
  sessions?: BodySessions;
  /** The same seam for the files sent with bridge messages. */
  saveAttachments?: typeof saveBodyAttachments;
  showAttachments?: typeof showBodyAttachments;
  /** The same seam for a bridge channel's brief. */
  loadBrief?: typeof bodyChannelBrief;
  /** How many processes the system's memory killer has ended in this body's container so far; a test names its own. */
  memoryKills?: () => number | undefined;
  error: (text: string) => void;
}): Promise<number> {
  let bytes: Uint8Array | undefined, bootstrap: BodyBootstrap | undefined;
  // The stage the body is in, as the exit code a failure there reports (see job-exit.ts).
  let exit:number=BODY_EXIT.input;
  const progressReceipts=new Map<string,string>();
  let tools:Awaited<ReturnType<typeof bodySecretTools>>|undefined;
  let programTools:ReturnType<typeof bodyProgramTools>|undefined;
  let client: ReturnType<typeof bodyConversationClient> | undefined;
  let memoryClient:ReturnType<typeof bodyCommandClient>|undefined,sessionClient:ReturnType<typeof bodyCommandClient>|undefined;
  let keeper:BodySessions|undefined,saved=false;
  // Why the harness failed, as one of the fixed reasons (job-failure.ts): handed to the worker with the exit code.
  let failed:JobFailure|undefined;
  const context: string[] = [], incoming:string[]=[],discordAttachments=new Map<string,string>();
  let pending: Promise<void> | undefined, cancel: (()=>void) | undefined, stopped=false, unavailable=false;
  // Every report to loom goes through here. One that fails after the first exchange is the stage that failed
  // (BODY_EXIT.contact), whatever the body was doing when it reported; the first is BODY_EXIT.report.
  let first=true,contactExpired=false;
  const jobEnded=new AbortController(),jobSignal=AbortSignal.any([input.signal,jobEnded.signal]);
  const onJobEnded=()=>{unavailable=true;jobEnded.abort();erase();};
  const tell=(value:Parameters<NonNullable<typeof client>['status']>[0])=>client!.status(value).catch((error:unknown)=>{if(error instanceof BodyContactExpired)contactExpired=true;if(!first)unavailable=true;throw error;});
  const stopBeats=async()=>{cancel?.();cancel=undefined;await pending;};
  const nativeAbort = new AbortController(), signal = AbortSignal.any([jobSignal,nativeAbort.signal]);
  const secrets = bodyStartupSecrets(input.env, {fetch:input.fetch,clock:input.clock,onJobEnded});
  const erase = () => { bytes?.fill(0); eraseBootstrap(bootstrap); context.length = 0; incoming.length=0; };
  let retirement:Promise<void>|undefined;
  let measuredDelivery: Promise<unknown> | undefined;
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
      job: job.id, conversation: job.conversation, signal: jobSignal, onJobEnded, fetch: input.fetch, clock: input.clock });
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
    // A job on anybody else's word runs with loom's tools only (policy.ts, loomToolsOnly): no secret is asked
    // for and none enters its environment. The word is the one loom read at claim; loom's door refuses such a
    // job the same secrets, so a body program that asked anyway would get nothing.
    // A frozen review (conversation.review) asks for none either: it is handed no secret, and loom's door refuses one
    // (shared-secret-inputs.ts), so the reviewer's environment holds no credential that could push.
    const frozen=!!job.frozenReview;
    if(!hasGuest(job.run?.policy)&&!frozen) await (input.startup ?? secrets.startup)(job, bootstrap, signal);
    if (signal.aborted) throw new Error();
    work='Working on accepted mail';
    exit=BODY_EXIT.mail;
    // The body of a bridge conversation, or of a member's own thread with the agent, continues the session the
    // last one left, when loom hands one over (body-session.ts). Continue with new mail and the retained lines
    // missing from that session. With none, it starts fresh and is told the conversation's kept history with its mail.
    // Not a wake or a handed-off session: each is one job, with nothing before it to continue.
    // Not on anybody else's word: a kept session is the record of what an owners' body read and used. Such a
    // body asks for none and leaves none, and starts fresh with the kept history. loom's doors refuse it both
    // on loom's own reading of the word (shared-conversation-sessions.ts), so one that asked would get nothing.
    // loom also refuses a thread that is no one member's, or archived: that body keeps none either.
    const ownThread=job.venue==='loom'&&!!job.thread&&!job.review;
    if((bridge||ownThread)&&!hasGuest(job.run?.policy)){
      sessionClient=bodyCommandClient({url:bootstrap.origin,token:parsed.bootstrap.token,signal:jobSignal,onJobEnded,fetch:input.fetch,clock:input.clock});
      keeper=input.sessions??(input.native?undefined:bodySessions(sessionClient,job.harness,input.env));
    }
    let resume=await keeper?.take();
    if(keeper?.refused){keeper=undefined;resume=undefined;}
    if(signal.aborted)throw new Error();
    // Keys identify individual posts even when two replies have identical text and timestamps.
    const keyOf=(id:string)=>createHash('sha256').update(id).digest('hex');
    const covered=new Set(keeper?.covered), seen=new Set<string>();
    const continued:string[]=[];let oldestErased:string|undefined,firstErased:string|undefined,answeredBefore=false;
    // When the first of the erasable words handed in will be erased: a session holding them is kept no longer (sessions.ts).
    const erasedAt=(until:string|null)=>{if(until!==null&&(firstErased===undefined||Date.parse(until)<Date.parse(firstErased)))firstErased=until;};
    // loom read who is in the room when it claimed the job. The body takes everything waiting, so mail from
    // outside the household may have arrived since; nobody looked that sender up, so they count as a guest.
    let deliveredItems = 0;
    let hasOwnSchedule = false;
    const journalDeliveries: string[] = [];
    const attachedMail: string[] = [];
    const claimed=job.run?.policy?.mail;let lateStranger=false,placed=false;
    const batch = await client.takeAndAccept(async (item, sinkSignal) => {
      if (sinkSignal.aborted || signal.aborted) throw new Error();
      deliveredItems++;
      if(job.venue==='loom' && item.source==='thread' && item.words?.match(/(?:^|\n)Attached files: \[/)) attachedMail.push(item.id);
      // This is the receiving body's context, never a parent's pipe queue.
      // Mail in a bridge conversation that is no message from the bridge: a trigger's firing there, or a note
      // from another body of this agent. Its answer is a post in the conversation, answering no message.
      if(job.venue === 'wake' && item.source === 'trigger' && item.fromKind === 'schedule' && item.words !== null) {
        journalDeliveries.push(item.id);
        if (item.fromId === job.agent) hasOwnSchedule = true;
      }
      const decision=bridge&&item.source==='answer'&&item.sourceId?.startsWith('guest-decision:')&&item.fromKind==='agent';
      if(decision&&!item.question)return;
      if(bridge&&(item.source==='trigger'||item.source==='handoff'||decision)&&item.words!==null)placed=true;
      if(bridge&&(item.source==='discord'||item.source==='slack')){
        const refs=item.refs.filter(ref=>ref.startsWith('bi:'));
        if(item.source!==job.venue||refs.length!==1)throw new Error();
        incoming.push(refs[0]);
        if(item.words!==null)seen.add(keyOf(refs[0]));
        // A hint to check Discord's own message record. No link or file id is read from the words.
        if(item.source==='discord'&&item.words&&discordAttachmentLabels(item.words).length)discordAttachments.set(refs[0],item.words);
      }
      if(claimed&&item.fromKind==='unknown'&&!claimed.includes(item.id))lateStranger=true;
      // The oldest word handed in that will be erased: a session started from them is counted from then.
      for(const line of item.history)if(line.keepUntil!==null&&(oldestErased===undefined||Date.parse(line.at)<Date.parse(oldestErased)))oldestErased=line.at;
      if(job.venue==='loom' && item.source==='handoff' && item.words!==null){
        const returned='Your delegated worker returned the following result. Continue the originating request using the findings.';
        context.push(returned);continued.push(returned);
      }
      const words=bodyMailContext(item);
      if(words!==null){
        context.push(words);
        erasedAt(item.keepUntil);if(item.question)erasedAt(item.questionKeepUntil);for(const line of item.history)erasedAt(line.keepUntil);
        // A thread's lines are keyed by the mail a message was delivered as, and by the job that said a reply
        // (core/conversations/history-context.ts): this mail is in the session this body leaves.
        if(ownThread)seen.add(keyOf(item.id));
        if(item.history.some(line=>line.kind==='reply'))answeredBefore=true;
        for(const line of item.history)if(line.sourceKey)seen.add(keyOf(line.sourceKey));
        const missing=item.history.filter(line=>!line.sourceKey || !covered.has(keyOf(line.sourceKey)));
        continued.push(bodyMailContext({...item,history:missing})!);
      }
    },50,!!keeper && keeper.historyKeys!==false);
    if (batch.stopRequested) { await retire(); await tell(left); return BODY_EXIT.stopped; }
    if(signal.aborted)throw new Error();
    // Mail with no words left to answer (they expired, or the item is muted) needs no answer: settle it now.
    if (!context.length) {await stopBeats();if(signal.aborted)throw new Error();await client.settle();await tell({state:'idle',work:''});return 0;}
    // A bridge answer is a reply to a message from the bridge. Mail with words and no such message is mail
    // this body cannot answer, so it fails here, as mail, before anything else is loaded for it.
    if(bridge&&!incoming.length&&!placed)throw new Error();
    exit=BODY_EXIT.identity;
    memoryClient=bodyCommandClient({url:bootstrap.origin,token:parsed.bootstrap.token,signal,onJobEnded,fetch:input.fetch,clock:input.clock});
    if (journalDeliveries.length) {
      const result = await memoryClient.command('tempo.wakeLessons', {items:journalDeliveries}, randomUUID());
      // A worker can be upgraded before its coordinator during a rolling deployment.
      if (!result.ok && !(result.code === 'not-found' && result.message === 'Unknown operation')) throw new Error('Trigger lessons unavailable');
      const lessons = result.ok ? z.string().nullable().parse(result.value) : null;
      if (lessons) context.push('Lessons recorded by earlier runs of this trigger:\n' + lessons);
    }
    // A frozen reviewer starts with no memory or identity: what it reviews against is the brief loom wrote, and the
    // agent's memory may hold the author's own reasoning about the change (core/conversations/review-brief.ts).
    const memory=frozen?null:await (input.loadMemory?input.loadMemory(job.agent,signal):bodyMemoryIdentity(memoryClient,job.agent,job.venue));
    if(signal.aborted)throw new Error();
    // A bridge channel's rule may name a brief: one more of the agent's role pages, for conversations there.
    // A brief that cannot be found is never a reason to fail: the work goes on and loom tells the owners.
    const brief=bridge?await (input.loadBrief??bodyChannelBrief)(memoryClient,job.agent):null;
    if(signal.aborted)throw new Error();
    // What was sent with the messages, written where a body with file tools can open it (body-attachments.ts).
    // The room as it is now: a sender nobody looked up, who wrote after loom read the room, counts as a guest.
    const policy=lateStranger&&job.run?.policy?withUnknownSender(job.run.policy):job.run?.policy;
    // What this body may use, decided once here for everything below: loom's tools only on anybody else's word.
    const guest=hasGuest(policy),reach=bodyReach(plan.reach,policy);
    let omitClaudeTools: OmittedWakeTools = [];
    if (reach === 'all' && job.harness === 'claude' && journalDeliveries.length && journalDeliveries.length === deliveredItems) {
      const profile = await memoryClient.command('tempo.wakeToolProfile', {items: journalDeliveries}, randomUUID());
      if (profile.ok) omitClaudeTools = omittedWakeTools.safeParse(profile.value).data ?? [];
    }
    // The word turned after the startup secrets were fetched: they leave the environment before any harness starts.
    if(guest)secrets.close();
    // And the session it was handed before the word turned is not continued, and none is left: its files go
    // from this machine, and the body starts fresh with the kept history.
    if(guest&&keeper){keeper.discard();keeper=undefined;resume=undefined;}
    // A harness that cannot be held to loom's tools does not run such a job: the refusal made before the mail
    // was taken, made again now that the mail says more. loom leaves a late stranger's mail for the next job
    // (shared-place-mail.ts, lateMailJoins), so this is reached only if that failed. By now the mail is taken
    // and not settled: the body leaves with the exit code of an assignment its harness refuses, loom returns
    // the mail to the job (Jobs.finish), and the retry chain tries the work again.
    if(!input.native&&harnessCannotRun(job.harness,policy,plan.reach)){exit=BODY_EXIT.assignment;throw new Error();}
    // Files are for a body that has file tools of its own (harness-traits.ts, hasFileTools): what was sent with
    // the messages is written where it can open it, and it may name a file of its own for a post.
    const files=bridge&&hasFileTools(reach,policy);
    const sent=files?await (input.saveAttachments??saveBodyAttachments)(memoryClient,incoming,input.env[BODY_SCRATCH],undefined,job.venue==='discord'?discordAttachments:undefined)
      // A body without file tools is still told what it was sent, and shown the files that are plain words
      // (body-attachments.ts, showBodyAttachments). Discord's are fetched only for a job that is not held,
      // so there it is told only that it cannot open them.
      :discordAttachments.size?'You cannot open these attachments because this body has no file tools.'
      :bridge?await (input.showAttachments??showBodyAttachments)(memoryClient,incoming):null;
    if(signal.aborted)throw new Error();
    if(attachedMail.length){
      const attachments=await receiveChatFiles(memoryClient,attachedMail,hasFileTools(reach,policy)?input.env[BODY_SCRATCH]:undefined);
      context.push(attachments);continued.push(attachments);
    }
    if(sent){context.push(sent);continued.push(sent);}
    // A thread whose member has the second window: the body is told what is on its boards and what the member did
    // there, before its mail. Any other thread refuses the read and is told nothing (core/boards/operations.ts).
    if(job.venue==='loom'&&memoryClient){
      try{
        const brief=await memoryClient.command('boards.brief',{},randomUUID());
        const text=brief.ok&&(brief.value as {text?:unknown}|null)?.text;
        if(typeof text==='string'){const told=boardsMail(text);context.unshift(told);continued.unshift(told);}
      }catch{/* A brief that cannot be read is no reason to refuse the work. */}
      if(signal.aborted)throw new Error();
    }
    // In a bridge's room others speak beside the one who asked. The body is told who this job works for, by loom's
    // reading of the room, before its mail: a body that continues a kept session is told too, since the asker of
    // this job need not be the asker of the last (harness-traits.ts, workingFor).
    if(bridge || policy?.word === 'others' || (job.thread && policy?.word === 'owners')){const asked=workingFor(policy);context.unshift(asked);continued.unshift(asked);}
    const coordinating = job.venue === 'loom' && policy?.word === 'owners';
    if (coordinating || job.review) {
      const nativeBudget = 'Native subagents work within this job and share its account quota. Provider readings can lag while children are running. Start only as many children as the brief needs, and account for outstanding children before starting more.';
      context.unshift(nativeBudget);continued.unshift(nativeBudget);
    }
    if (job.venue === 'wake' && policy?.word === 'own' && hasOwnSchedule) {
      const activity = 'If you claim a project ticket, post meaningful updates for its readers through loom_command work.postUpdate. Use input {"task":"t-17","post":{"action":"open","title":"…","words":"…"}}. Save value.thread with the ticket checkpoint and reply there with {"action":"reply","thread":"…","words":"…"}. Give each update a stable command id and reuse it on retry. Share only information for the project audience.';
      context.unshift(activity); continued.unshift(activity);
    }
    if(coordinating){
      const activity = 'Post a short update to your agent card when you pick up work, discover something worth sharing, or finish. Use loom_command with operation "conversation.activityPost", a distinct id for each post (reuse it on retry), and input {"action":"open","words":"…","title":"…"} for a new activity. Write the post in your own voice. Give it a short thread title that summarizes what you picked up. Rename it later if the work takes a clearer shape. Keep value.thread from the receipt. Reply with {"action":"reply","thread":"…","words":"…"} or rename with {"action":"rename","thread":"…","title":"…"}. Attach related work with optional refs such as ["t-17","github:house/loom#7"] on an opener or reply. Returning to an activity? Reply to its thread.';
      context.unshift(activity);continued.unshift(activity);
      const delegation = [
        'For a Loom subagent, use the loom_command MCP tool. Loom runs the child on an eligible worker.',
        'Discover available roles, assigned peers and Codex capacity with {"operation":"conversation.handoffOptions","id":"discover-handoffs","input":{}}.',
        'Submit conversation.handoff through the same tool. Give the command a stable id. In input, include exactly one of role (a listed role), agent (a listed peer), or harness "codex", plus label, words and a clientId unique to the brief. Reuse both IDs and the same input when retrying that brief.',
        'When the work is for one or more tickets, also give tickets, a list of their ids such as ["t-17"]: loom records the session against each so the ticket can show the work done for it later. An id you cannot read refuses the handoff. Loom never reads ticket ids out of words.',
        'Make words self-contained. Include the repository and commit for repository work. To schedule a role or Codex job, supply notBefore as a UTC timestamp within the private brief retention period.',
        'To have a pull request or a commit reviewed, use conversation.review, not a role handoff: input {"clientId":"…","label":"…","target":{"change":"owner/repo#7"} or {"repository":"owner/repo","commit":"<full 40-character id>"},"contract":"…"}. Loom pins the exact commit and its diff, gives the reviewer a read-only copy and no credential that can push, and returns its answer here with the verdict it filed. In contract give only what to review against (the ticket, the spec section, the acceptance criteria), never your own reasoning about the change.',
        'Role and Codex results return to this thread. Check progress with conversation.handoffStatus, passing value.conversation from the receipt as input.conversation. To cancel a scheduled handoff before it gets a job, call conversation.handoffCancel with the same child conversation. For help inside this job, use native subagents when your harness provides them.',
      ].join(' ');
      context.unshift(delegation);continued.unshift(delegation);
    }
    if(job.venue==='discord'&&job.venueDescription){
      const where='Current conversation: '+job.venueDescription+'. This is your location for this turn, including when your Discord role page describes the server in general.';
      context.unshift(where);continued.unshift(where);
    }
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
      const rootAccess={url:bootstrap.origin,token:parsed.bootstrap.token,signal,onJobEnded,clock:input.clock,fetch:input.fetch,agent:job.agent,identityHanded:!!memory};
      const houseShell=reach==='all'&&Object.hasOwn(input.env,BODY_OWN_HARNESS);
      programTools=bodyProgramTools({...rootAccess,...(frozen?{frozen:true}:{}),
        ...(houseShell&&hasFileTools(reach,policy)&&mayAttachNoteFile(deniedTools(policy))?{
          noteUpload:{read:bodyNoteFileReader(plan.cwd,[plan.cwd,input.env[BODY_SCRATCH]]),allows:(bytes:Buffer)=>tools?.allowsBytes(bytes)===true}
        }:{}),
        ...(houseShell&&mayReadNoteFile(deniedTools(policy))?{allowsFileBytes:(bytes:Buffer)=>tools?.allowsBytes(bytes)===true}:{}),
        onStop:()=>observe({stopRequested:true}),onStatus:value=>{state=value.state==='waiting'?'waiting':'working';work=value.work;},
        ...(files?{readFiles:bodyFileReader(plan.cwd,[plan.cwd,input.env[BODY_SCRATCH]])}:{})});
      const kitBrief=(items:KitUnavailable[])=>{
        for(const {kit,reason,partial} of items){
          const subject=partial?`Some tools in kit ${kit} are unavailable`:`Kit ${kit} is unavailable`;
          const line=`${subject} because ${kitReasons[reason].why}.`;
          context.push(line);continued.push(line);
        }
      };
      if(!lateStranger)kitBrief(parsed.kitUnavailable??[]);
      if(!lateStranger && parsed.kitReportFailed){
        const line='The worker could not load kit tools or report their availability for this job.';
        context.push(line);continued.push(line);
      }
      const available=parsed.kitSocket&&!lateStranger?await bodyKitTools(KIT_SOCKET,signal,kitBrief,()=>{
        const line='The worker could not confirm that kit availability was reported for this job.';
        context.push(line);continued.push(line);
      }).catch(error=>{
        const line=error instanceof KitCapacity?error.message:'The worker could not load kit tools for this job.';
        context.push(line);continued.push(line);
        return [];
      }):[];
      tools=await bodySecretTools({...rootAccess,job:job.id,conversation:job.conversation,extraTools:[...programTools.extensions,...available],waiting:value=>{secretWaiting=value;},
        ...(houseShell?{houseSend:{venue:job.venue??'loom',denied:deniedTools(policy),call:programTools.call,attempted(id,text){
          const digest=keyOf(text),previous=progressReceipts.get(digest);
          progressReceipts.set(digest,id);
          return ()=>{
            if(progressReceipts.get(digest)!==id)return;
            if(previous)progressReceipts.set(digest,previous);
            else progressReceipts.delete(digest);
          };
        }},houseNotes:{denied:deniedTools(policy),call:programTools.call}}:{}),
        secrets:!guest,alsoSecret:secrets.values});
    }
    if(signal.aborted)throw new Error();
    // The member is told, in their own thread, when a job that could have continued the thread's session did not:
    // a step among the thread's cards, in loom's fixed words, which no later body is told as history. Only where
    // this body keeps sessions at all, and only when the thread was answered before: a first job continues nothing.
    // Never a reason to fail the work.
    const sessionNote=async(id:string,words:string)=>{
      if(!ownThread||jobSignal.aborted)return;
      try{await client!.card({tool:'Session',words,cardState:'done',clientId:id});}catch{/* the work goes on */}
    };
    if(keeper&&!resume&&answeredBefore)await sessionNote('session-fresh','Started fresh: loom handed this job no session to continue. None was kept for this thread and harness, or the one kept was past its keep time, saved under another family of models, behind the thread\'s last answer, or could not be put back. The job was told the thread\'s kept history instead.');
    if(signal.aborted)throw new Error();
    exit=BODY_EXIT.harness;
    let failureReport:UsageReport|undefined;
    const shellEnv={...input.env};
    delete shellEnv.LOOM_BODY_HOUSE_SEND;
    if(tools?.houseSend)shellEnv.LOOM_BODY_HOUSE_SEND=tools.houseSend;
    delete shellEnv.LOOM_BODY_HOUSE_NOTE;
    if(tools?.houseNote)shellEnv.LOOM_BODY_HOUSE_NOTE=tools.houseNote;
    // Native work cards are published by two kinds of job, both on the owners' word: one in the owner's dedicated
    // pairing room, whose cards enter its thread; and one handed off from an owner's thread (job.review), whose
    // cards loom keeps beside the handoff conversation as that session's trace (core/conversations/job-trace.ts).
    // Both pass the one disclosure check below.
    const traced = !guest && (coordinating && PAIR_THREAD.test(job.thread||'') || job.venue==='handoff' && job.review===true && policy?.word==='owners');
    let posted = Promise.resolve();
    const privateValues = [parsed.bootstrap.token, harnessTools(tools?.config)?.authorization.slice(7), tools?.houseSend, tools?.houseNote,...Object.entries(shellEnv)
      .filter(([key])=>/token|secret|password|api.?key|authorization/i.test(key))
      .map(([,value])=>value)].filter((v):v is string=>typeof v==='string'&&v.length>=8);
    // The one disclosure check for anything this body shows of its harness's work: a step, and the harness's last error.
    const sensitive=(value:string)=>!(tools??secrets).allowsReply(value)||privateValues.some(v=>value.includes(v))||
      /(?:Bearer\s+[A-Za-z0-9_.+/=-]{12,}|-----BEGIN [^\n]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})/i.test(value);
    // Words and reasoning are a handed-off session's alone: a pairing thread's cards are tool steps, as they were.
    const session = traced && job.venue==='handoff';
    let textKept = 0, textFull = false;
    const pairOutput = traced
      ? pairEvents(step=>{
          const kind = step.kind ?? 'tool';
          if(kind!=='tool'){
            if(!session||textFull)return;
            let words=sensitive(step.words)?'Output withheld.':step.words;
            if(words.length>TRACE_TEXT_STEP_MAX)words=words.slice(0,TRACE_TEXT_STEP_MAX)+TRACE_TEXT_CUT;
            const full=textKept+words.length>TRACE_TEXT_JOB_MAX;
            if(full)textFull=true;else textKept+=words.length;
            const card=full?{tool:'Session',words:TRACE_TEXT_FULL,cardState:'done' as const,clientId:'session-text-full'}
              :{tool:kind==='words'?'Words':'Reasoning',words,cardState:'done' as const,stepKind:kind,clientId:(kind==='words'?'say.':'think.')+randomUUID()};
            posted=posted.then(async()=>{if(!signal.aborted)await client!.card(card)}).catch(()=>{});
            return;
          }
          // One clean line, as loom takes a step's tool (core/line-name.ts): a refused step would be lost.
          const tool=sensitive(step.tool)?'Tool':cleanLineOf(step.tool).slice(0,180)||'Tool';
          const words=sensitive(step.words)?'Output withheld.':step.words.length>16000?step.words.slice(0,16000)+'\n[Output truncated]':step.words;
          const callId=step.call ? 'pair.'+keyOf(step.call).slice(0,24)+'.'+(step.parent?keyOf(step.parent).slice(0,24):'-')+'.'+randomUUID() : randomUUID();
          posted=posted.then(async()=>{if(!signal.aborted)await client!.card({tool,words,cardState:step.cardState,clientId:callId})}).catch(()=>{});
        }) : undefined;
    const harness = () => input.native ?? bodyHarness(job.harness, { ...plan, ...(frozen?{cwd:frozenReviewCwd(plan.cwd,input.env[BODY_SCRATCH])}:{}), reach, omitClaudeTools, pairOutput, env: shellEnv, failedUsage:usage=>{failureReport=usage;}, mcpConfig:tools?.config,mcpTools:tools?.allowedTools });
    // A second one for the case the session cannot be continued: each takes its own copy of the tools file.
    const native = harness(), afresh = resume ? harness() : undefined;
    tools?.config.fill(0);
    let answer: Awaited<ReturnType<typeof native>> | undefined;
    let refusedReply=false;
    const room=policy&&job.run&&policy!==job.run.policy?{...job,run:{...job.run,policy}}:job;
    const harnessStarted=performance.now();
    const memoryKills=input.memoryKills??cgroupMemoryKills,killsBefore=memoryKills();
    let failure:HarnessFailed|undefined;
    try {
      if(!keeper)answer = await native(room, context.join('\n\n'), signal);
      else try { answer = await native(room, (resume?continued:context).join('\n\n'), signal, resume?{resume}:{}); }
      catch (error) {
        // The harness could not continue the session and did nothing: the same work, afresh, with the history.
        if(!(error instanceof HarnessResumeUnavailable)||!afresh||signal.aborted)throw error;
        await sessionNote('session-fresh','Started fresh: the harness could not continue the session kept for this thread. The job was told the thread\'s kept history instead.');
        answer = await afresh(room, context.join('\n\n'), signal, {});covered.clear();
      }
      // No secret this body was handed is said in its answer: one it used, or one it was started with.
      // One check (body-secrets.ts, saysNoSecret): the tools know the startup values too, and with no tools there are only those.
      refusedReply=!(tools??secrets).allowsReply(answer.text);
    }
    // A harness's diagnostics never leave the body as its error. What the adapter could tell of the failure is
    // kept apart: the fixed reason for the job's record, and the harness's own words for the conversation's readers.
    catch (error) { if(error instanceof HarnessFailed)failure=error; if(!stopped) throw new Error(); }
    finally {
      await posted;
      if(failure&&!answer&&!stopped&&!unavailable&&!jobSignal.aborted){
        // A signal that ended the harness while the memory killer was at work in this container was that killer's.
        const killsAfter=memoryKills(),why=failure.why;
        failed=(why.reason==='killed'||why.reason==='harness-crashed'&&why.exitCode===137)&&killsBefore!==undefined&&killsAfter!==undefined&&killsAfter>killsBefore?{reason:'out-of-memory'}:why;
        // The last step of the work, for those who may read the conversation and nobody else: a sealed step of a
        // session that keeps its steps, or a card in the member's own thread. The reason in loom's words, then what
        // the harness itself said, through the same check as every step. Never a reason to fail differently.
        if(!guest&&(traced||job.venue==='loom'&&!!job.thread)){
          const said=failure.said?.trim();
          const words='Stopped: '+failureWords(failed)+'.'+(said?'\n\n'+(sensitive(said)?'Output withheld.':said):'');
          try{await client.card({tool:'Harness',words,cardState:'failed',clientId:'harness-failed'});}catch{/* the failure is reported either way */}
        }
      }
      const report = {...(answer?.usage ?? failureReport ?? {source:'none' as const}), harness:job.harness,
        model:answer?.model ?? job.model, wallMs:Math.round(performance.now()-harnessStarted)};
      // Keep a valid measurement in flight during retirement and reply settlement.
      // Unmeasured or malformed reports must never hold the body open.
      const measured = !input.signal.aborted && report.source !== 'none' && usageReport.safeParse(report).success;
      const delivery = client.usage(report, 1000).catch(()=>{});
      if (measured) measuredDelivery = delivery;
      await retire();
    }
    if(stopped && !jobSignal.aborted) { await tell(left); return BODY_EXIT.stopped; }
    if(unavailable || !answer) throw new Error();
    if (input.signal.aborted) throw new Error();
    if(refusedReply){
      // Keep only the outcome. A rejected answer may carry a secret even in
      // its metadata. Report after the tools and startup inputs are retired.
      await client.turn({kind:'refused',outcome:'failed'});
      throw new Error();
    }
    exit=BODY_EXIT.record;
    for (const action of answer.actions) await client.turn({ kind: 'action', model: action.model, outcome: 'progressed' });
    const repeated=progressReceipts.get(keyOf(answer.text));
    const replyId=repeated??randomUUID();
    if(bridge)await client.bridgeReply({...(replyTo?{incoming:replyTo}:{}),text:answer.text,model:answer.model,outcome:'progressed'},replyId,repeated?'final:'+replyId:replyId);
    else if(job.review)await client.reply({clientId:'review-result',words:answer.text,model:answer.model,outcome:'progressed'});
    else if(background){
      await client.turn({kind:'reply',model:answer.model,outcome:'progressed'});
    }
    else await client.reply({ clientId: repeated??randomUUID(), ...(repeated?{progressId:repeated}:{}), words: answer.text, model: answer.model, outcome: 'progressed' });
    // The answer is recorded; only now is the mail done. loom has already settled what a thread or bridge reply
    // answers, so this covers the rest: background work, and earlier bridge messages the one reply also answers.
    await client.settle();
    // The answer is on record. Hand loom the session this run left, for the next body of this conversation,
    // and take its files off this machine. Never a reason to fail work that is done.
    // Save the record IDs the harness knows, including its reply even if the provider posts it later.
    try{
      if(keeper){
        // In a thread, everything this job said there is keyed by the job (history-context.ts, threadRunKey).
        const current=new Set([...seen,keyOf(replyId),...(ownThread?[keyOf(threadRunKey(job.id))]:[])]);
        const previous=[...covered].filter(key=>!current.has(key));
        const kept=await keeper.save(answer.session,oldestErased,[...previous,...current].slice(-SESSION_HISTORY_KEYS),firstErased);
        if(kept===false)await sessionNote('session-unkept',`This job's session was not kept for the next one: it is larger than ${SESSION_BYTES/1024} KB packed, the harness left none, or loom did not take it. The next job in this thread starts fresh with the thread's kept history.`);
      }
      saved=true;
    }catch{/* loom sees the kept session is behind the answer */}
    // Reply words have their own storage and retention. Completion metadata must
    // not make a second durable copy, and must preserve any model-authored digest.
    if(jobSignal.aborted)throw new Error();
    // Not a frozen reviewer's: a digest can carry a question to an owner, and such a body may call nothing but its
    // reply and its own job's bookkeeping (core/conversations/review-confinement.ts). Its answer is its record.
    if(!frozen)await client.digest({summary:'Completed this stretch of work.',ifAbsent:true});
    await tell({ state: 'idle', work: '' });
    return 0;
  } catch (error) {
    if(error instanceof BodyContactExpired){unavailable=true;contactExpired=true;}
    if(error instanceof BodyJobEnded)unavailable=true;
    await retire();
    if(stopped&&!unavailable&&!input.signal.aborted&&client){
      try{await tell(left);return BODY_EXIT.stopped;}catch{}
    }
    // A report that failed is why the work was dropped, whichever stage was dropped.
    // The harness's reason goes with the harness's exit code, as one line that holds no words (job-failure.ts, failureLine).
    const why=failed&&!unavailable&&exit===BODY_EXIT.harness?failureLine(failed):'';
    input.error((contactExpired?BODY_CONTACT_MESSAGE+'\n':'Body stopped: invalid input or unavailable execution\n')+why); return unavailable?BODY_EXIT.contact:exit;
  }
  finally { await retire(); await measuredDelivery; if(!saved){try{keeper?.discard();}catch{}} sessionClient?.close(); client?.close(); input.signal.removeEventListener('abort', erase); }
}
/** How many processes the memory killer has ended in this body's own container (cgroup v2, `memory.events`).
 * Undefined where that cannot be read: a body that is not in a container, or an older kernel. */
function cgroupMemoryKills():number|undefined{
  try{const found=/^oom_kill (\d+)$/m.exec(readFileSync('/sys/fs/cgroup/memory.events','utf8'));return found?Number(found[1]):undefined;}
  catch{return undefined;}
}
