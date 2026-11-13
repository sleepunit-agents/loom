/** Runtime is in-process and holds this capability; tokens never obtain it. */
export interface Delivery { thread: string; agent: string; member: string; conversation: string; seq: number; text: string; project?: string }
export interface RuntimeDelivery {
 deliver(message: Delivery): Promise<void>;
 end(conversation: string): Promise<void>;
}
/** The frame's staging gate must wrap every effect, including runtime delivery. */
export type Hold = <T>(effect: () => Promise<T>, facts?: EffectFacts) => Promise<T>;
import type { Viewer, Result } from '../../core/index.js';
/** Structural subset of attention/role.ts; keep the original member and stable retry id. */
export interface Attention {
 answer(viewer: Viewer, input: { id: string; answer: { kind: 'yes' | 'no' } | { kind: 'words'; text: string } }, operationId: string): Result;
}
export interface AgentPost {
 id: string; kind: 'reply' | 'card' | 'ask' | 'error'; text: string;
 run?: string; tool?: string; state?: 'running' | 'done' | 'failed';
 ref?: string; step?: Record<string, unknown>;
}
export interface Comms {
 /** Only the trusted runtime constructs this binding; never derive it from tool arguments. */
 reader(binding: ReadBinding): ThreadReader;
 post(agent: string, thread: string, message: AgentPost): Promise<{ seq: number }>;
 deliver(agent: string, thread: string, seq: number): Promise<void>;
 title(agent: string, thread: string, title: string): void;
 status(agent: string, thread: string): { stop: boolean; archived: boolean };
}
export interface ReadBinding {
 agent: string; conversation?: string;
 /** undefined means a local body; an empty list means a service/unbound house. */
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
