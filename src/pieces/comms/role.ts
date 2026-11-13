/** Runtime is in-process and holds this capability; tokens never obtain it. */
export interface Delivery { thread: string; agent: string; member: string; conversation: string; seq: number; text: string; project?: string }
export interface RuntimeDelivery {
 deliver(message: Delivery): Promise<void>;
 end(conversation: string): Promise<void>;
}
/** The frame's staging gate must wrap every effect, including runtime delivery. */
export type Hold = <T>(effect: () => Promise<T>) => Promise<T>;
export interface Attention {
 answer(member: string, ref: string, verdict: 'yes' | 'no', words?: string): Promise<void>;
}
export interface AgentPost {
 id: string; kind: 'reply' | 'card' | 'ask' | 'error'; text: string;
 run?: string; tool?: string; state?: 'running' | 'done' | 'failed';
 ref?: string; step?: Record<string, unknown>;
}
export interface Comms {
 post(agent: string, thread: string, message: AgentPost): Promise<{ seq: number }>;
 deliver(agent: string, thread: string, seq: number): Promise<void>;
 title(agent: string, thread: string, title: string): void;
 status(agent: string, thread: string): { stop: boolean; archived: boolean };
}
