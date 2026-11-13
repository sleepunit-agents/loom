/** Bridges own venue IO only. The runtime owns gates, turns, bodies and continuity. */
import type { Address, ConversationKey, Message, Route, Venue } from './model.js';
export interface Incoming {
  /** Stable across a retry, restart and receipt by several bot connections. */
  id: string; key: ConversationKey; person: string; text: string;
  address: Address; route?: Route;
}
export interface BridgeRuntime {
  /** Gate by the current owner-written runtime policy, never by a People card. */
  admit(input: { agent: string; person: string; venue: string; channel: string; dm: boolean; group?: boolean; readers: string[]; peer: boolean }): Promise<'allow' | 'drop' | 'wait'>;
  /** Atomically deduplicate id, append ONE turn and arrange body delivery. */
  deliver(input: Incoming): Promise<void>;
  stop(input: { agent: string; venue: string; person: string; id: string }): Promise<void>;
}
/** The grant check happens before obtaining a value. No file fallback. */
export interface BridgeSecrets {
  may(agent: string, name: string): Promise<boolean>;
  get(agent: string, name: string): Promise<string>;
}
export interface VenueConnection { close(): void }
export interface VenueAdapter {
  platform: Venue['platform'];
  connect(venue: Venue, credentials: { token: string; appToken?: string }, callbacks: {
    /** A gateway acknowledges only after this resolves (durably received). */
    message(message: Message): Promise<void>; dropped(): void;
  }): Promise<VenueConnection>;
  /** Slack workspace/guest/group checks. A failure is wait, never allow. */
  inspect(venue: Venue, token: string, message: Message): Promise<'allow' | 'drop' | 'wait'>;
  send(venue: Venue, token: string, address: Address, text: string, operationId: string): Promise<{ id: string }>;
}
export interface BridgesRole {
  /** Stable id from runtime's reply operation. Replay returns the original state. */
  reply(input: { id: string; incomingId: string; text: string }): void;
}
