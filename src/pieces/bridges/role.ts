/** Bridges own venue IO only. The runtime owns gates, turns, bodies and continuity. */
import type { Context } from '../../core/index.js';
import type { Address, ConversationKey, Message, Route, Venue } from './model.js';
export interface Incoming {
  /** Stable across a retry, restart and receipt by several bot connections. */
  id: string; key: ConversationKey; person: string; text: string;
  /** ISO UTC milliseconds from the platform event. */
  at: string; label?: string;
  address: Address; route?: Route;
}
export type DeliveryOutcome = 'delivered' | 'refused' | 'retry' | 'held';
export interface BridgeRuntime {
  /** Gate by the current owner-written runtime policy, never by a People card. */
  admit(input: { agent: string; person: string; venue: string; channel: string; dm: boolean; group?: boolean; readers: string[]; peer: boolean }): Promise<'allow' | 'drop' | 'wait'>;
  /** Atomically deduplicate id, append ONE turn and arrange body delivery. */
  deliver(input: Incoming): Promise<DeliveryOutcome>; // Refusal consumes; malformed input holds; transient failure retries.
  stop(input: { agent: string; venue: string; person: string; id: string }): Promise<void>;
}
export interface VenueConnection { close(): void }
/** Slack allows only after authenticated platform checks. Group members are the
 * complete fresh conversations.members set (including the receiving bot); each
 * human passed users.info. Outbound inspection must also verify current MPIM
 * kind via conversations.info, without an intake cache. */
export type Inspection = 'allow' | 'drop' | 'wait' | { kind: 'allow'; members: string[] };
export interface VenueAdapter {
  platform: Venue['platform'];
  /** Capture a lifetime predicate before awaits; loss/recovery invalidates it. */
  current(venue: Venue): () => boolean;
  connect(venue: Venue, callbacks: {
    /** A gateway acknowledges only after this resolves (durably received). */
    message(message: Message): Promise<void>; dropped(): void;
  }): Promise<VenueConnection>;
  /** Slack workspace/guest/group checks. A failure is wait, never allow. */
  inspect(venue: Venue, message: Message): Promise<Inspection>;
  send(venue: Venue, address: Address, text: string, operationId: string, authorize: () => Promise<boolean>): Promise<{ id: string }>;
}
export interface BridgesRole {
  /** Stable id from runtime's reply operation. Replay returns the original state.
   * Inside an operation transaction pass its context, so changes publish only on commit. */
  reply(input: { id: string; incomingId: string; text: string }, context?: Pick<Context, 'changed'>): void;
}
