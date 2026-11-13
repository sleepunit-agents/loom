/** Runtime is in-process and holds this capability; tokens never obtain it. */
export interface Delivery { thread: string; agent: string; member: string; conversation: string; seq: number; generation?: number; text: string; project?: string }
export type DeliveryReceipt = Omit<Delivery, 'text'>;
export interface RuntimeDelivery {
 /** Authoritative lookup by stable routing identity. Unknown/errors never authorize replay.
  * not-accepted guarantees no earlier attempt can subsequently be accepted. */
 receipt?(message: DeliveryReceipt): Promise<'accepted' | 'not-accepted' | 'unknown'>;
 deliver(message: Delivery): Promise<void>;
 /** Must tolerate replay after an uncertain crash, scoped to this conversation. */
 end(conversation: string): Promise<void>;
}
/** The frame's staging gate must wrap every effect, including runtime delivery. */
export type Hold = <T>(effect: () => Promise<T>, facts?: EffectFacts) => Promise<T>;
import type { Operations, Viewer, Result } from '../../core/index.js';
/** Structural subset of attention/role.ts; keep the original member and stable retry id. */
export interface Attention {
 answer(viewer: Viewer, input: { id: string; answer: { kind: 'yes' | 'no' } | { kind: 'words'; text: string } }, operationId: string): Result;
}
export interface AgentPost {
 id: string; kind: 'reply' | 'card' | 'ask' | 'error'; text: string;
 on?: string; run?: string; tool?: string; state?: 'running' | 'done' | 'failed';
 ref?: string; step?: Record<string, unknown>;
}
/** Body record movement, distinct from the working heartbeat. Times are epoch milliseconds. */
export interface BodyAlive { at: number; tokens?: number }
/** A failed start for one member-message generation, after runtime accepted it as queued.
 * start-failed is authoritative: this generation can never subsequently start.
 * Echo Delivery.generation on every callback; absent means the initial generation (0). */
export type StartNotice = {seq: number; generation?: number; attempt: number; reason?: string; run?: string} &
 ({kind: 'start-retry'; retryAt: string} | {kind: 'start-failed'});
export interface DeliveryTrace {
 alive?: BodyAlive;
 thread: string; conversation: string; archived: number | null; working: boolean;
 messages: {seq:number;at:number;kind:string;from:string;delivery?: 'sending'|'held'|'failed'|'delivered'}[];
}
/** Supplied by the runtime, never by tool arguments. run is unique per body and
 * startedAt is its original epoch-ms start, preserved across capability renewal. */
export interface ConversationWriteBinding extends ReadBinding { conversation: string; run: string; startedAt: number }
export interface ConversationCard { id: string; tool: string; summary: string; state: 'running' | 'done' | 'failed' }
export interface ThreadCard extends ConversationCard {
 at?: string; end?: string; detail?: string; body?: string; result?: string;
 exit?: number; limit?: number; parent?: string;
 items?: {text: string; state: 'done' | 'now' | 'todo'}[];
}
export interface ThreadActivity {run: string; cards: readonly ThreadCard[]; alive?: BodyAlive}
/** Lock-screen-safe candidate for the frame's member-scoped push job, never message words. */
export interface ReplyAnnouncement {
 key: string; member: string; agent: string; open: true; title: string; body: string; url: string;
}
export interface SpawnThread { conversation: string; text: string; parent?: string; run?: string }
export interface Comms {
 /** Assigned runner confirmed this accepted message generation started. */
 confirmStart(agent: string, thread: string, seq: number, generation: number): void;
 /** Runtime proof is checked again inside the encrypted write transaction. */
 bodyPost(binding: ReadBinding, thread: string, message: AgentPost): Promise<{seq: number}>;
 /** Trusted runtime creation only; supplied authoritative spawn conversation is preserved. */
 spawn(agent: string, input: SpawnThread): Promise<{thread: string}>;
 /** Trusted frame role only. Recompute immediately before push; do not cache across awaits.
  * The sender must match subscriptions to member, deduplicate key and pass staging hold. */
 announcements(member: string): ReplyAnnouncement[];
 /** Runtime-checked private cards; whole-batch validation and atomic persistence. */
 activityCards(agent: string, thread: string, input: ThreadActivity): Promise<{added: number; updated: number}>;
 /** Label-only activity for ordinary conversations. Private venues use post instead. */
 conversationWriter(binding: ConversationWriteBinding): {write(cards: readonly ConversationCard[]): Promise<{added: number; updated: number}>};
 /** One encrypted line per member message; late/duplicate attempts cannot replace progress. */
 startNotice(agent: string, thread: string, notice: StartNotice): Promise<{seq: number | null}>;
 /** Private startup brief for the trusted runtime; no window/token operation. */
 describe(agent: string, thread: string): {brief: string[]; readers: string[]};
 /** Retry durable end jobs at startup or after staging release; no private words. */
 reconcileEnds(): Promise<void>;
 /** Resume staging-held sends; settle ineligible sends without replaying uncertain runtime calls. */
 reconcileDeliveries(): Promise<void>;
 /** Bounded routing/delivery facts only; never decrypts private work details. */
 trace(agent: string, thread: string): DeliveryTrace;
 /** Only the trusted runtime constructs this binding; never derive it from tool arguments. */
 reader(binding: ReadBinding): ThreadReader;
 /** Terminal runtime event, deduplicated by its stable run/event id; clears working atomically once. */
 notice(agent: string, thread: string, notice: {kind: 'no-reply' | 'loop'; id: string}): Promise<{seq: number}>;
 /** Replies with a spawn-run-<12 lowercase hex> ref keep the first report across post ids. */
 post(agent: string, thread: string, message: AgentPost): Promise<{ seq: number }>;
 deliver(agent: string, thread: string, seq: number): Promise<void>;
 title(agent: string, thread: string, title: string): void;
 /** Monotonic body movement; never starts or extends a working turn. */
 activity(agent: string, thread: string, alive: BodyAlive): void;
 /** Optional heartbeat updates working state; omitted state only consumes stop. */
 status(agent: string, thread: string, state?: 'working' | 'done'): { stop: boolean; archived: boolean };
}
export interface ReadBinding {
 agent: string; conversation?: string;
 /** Additional house restriction; conversation is always required for private reads.
  * An empty list means a service/unbound house. */
 houseConversations?: readonly string[];
 valid(): boolean;
}
export interface ThreadReader {
 read(input?: {thread?: string; before?: number; limit?: number}): Promise<{thread: {id:string;title:string|null;archived:number|null;working:boolean};messages: import('../../core/index.js').LiveRecord[]}>;
}
/** Frame supplies its beforeOutside/finish gate; facts carry routing metadata, never words. */
export interface EffectFacts { id: string; kind: 'body-start'; title: string }
export interface OutsideEffects { beforeOutside(effect: EffectFacts): boolean; finish(id: string, certain?: boolean): void }
export class HeldEffect extends Error {}
export function stagingHold(effects: OutsideEffects): Hold {
 return async (run, facts) => {
  if (!facts || !effects.beforeOutside(facts)) throw new HeldEffect('Outside effect held');
  try {const result=await run();effects.finish(facts.id);return result;}
  catch(error){effects.finish(facts.id,false);throw error;}
 };
}

/** Metadata-only seam; private thread filing never enters a public conversation. */
export interface CommsMetadata {
 threadProject(viewer: Viewer, conversation: {id: string; agent: string; member?: string}): string | null;
}
const metadataRoles = new WeakMap<Operations, CommsMetadata>();
export function registerCommsMetadata(operations: Operations, role: CommsMetadata): void { metadataRoles.set(operations, role); }
/** Late lookup permits independent piece installation; absence never opens a store. */
export function commsMetadata(operations: Operations): CommsMetadata | undefined { return metadataRoles.get(operations); }
