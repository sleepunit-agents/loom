import { createHash } from 'node:crypto';
/** The desk's seam. Other pieces raise/resolve asks here, never in their own tables. */
import { migrate, failure, type Db } from '../../core/index.js';
import { schema } from './schema/001.js';
import type { Context, Operations, Result, Scope, Viewer } from '../../core/index.js';

export type WaitsOn = { approval: string } | { task: string };
export interface Question {
  ask: string;
  why?: string;
  if_yes?: string;
  if_no?: string;
  href?: string;
  refs?: string[];
  waits_on?: WaitsOn;
  answers?: 'yes-no' | 'words';
}
export interface AskSource {
  kind: 'conversation' | 'approval' | 'task' | 'piece';
  id: string;
}
export interface RaiseAsk extends Question, Scope {
  /** Stable source-owned identity. Raising it again must not reopen an answered ask. */
  id: string;
  source: AskSource;
}
export type AskAnswer =
  | { kind: 'yes' | 'no' | 'done' | 'dismiss' }
  | { kind: 'words'; text: string };
export interface Ask extends RaiseAsk {
  /** An in-process source owns application of the answer; fail closed if absent. */
  sourceManaged?: true;
  state: 'open' | 'answered' | 'resolved';
  createdAt: number;
  changedAt: number;
  /** Wordless reply acknowledgements may carry a Comms reference; legacy imports have none. */
  answer?: (AskAnswer | { kind: 'replied'; reply?: {thread: string; seq: number} }) & { by: Viewer; at: number };
  resolution?: string;
}
export interface AgentStatus extends Scope {
  id: string;
  agent: string;
  state: 'working' | 'waiting' | 'idle' | 'offline';
  work: string;
  jobs: Array<{ id: string; label: string; href?: string }>;
  watched: Array<{ id: string; label: string; href?: string }>;
  changedAt: number;
}
/** All calls retain the original viewer and registry policy/transaction/retry checks.
 * A resolve records an external fact (e.g. approval answered), never a person's answer.
 * Only member answer paths write answer.by; first answer wins. Agents cannot answer person asks.
 */
export interface PrivateReply {
  id: string; conversation: string; agent: string; member: string; thread: string; seq: number;
}
const privateReplies = new WeakMap<object, (ctx: Context, input: PrivateReply) => Result>();
/** Trusted composition only; the handler receives the enclosing Comms transaction. */
export function registerPrivateReplies(operations: Operations, reply: (ctx: Context, input: PrivateReply) => Result): void {
  if (privateReplies.has(operations)) throw new Error('Private reply role already installed');
  privateReplies.set(operations, reply);
}
export interface Attention {
  privateReply(ctx: Context, input: PrivateReply): Result;
  raise(viewer: Viewer, input: RaiseAsk, operationId: string): Result;
  resolve(viewer: Viewer, input: { id: string; reason: string }, operationId: string): Result;
  answer(viewer: Viewer, input: { id: string; answer: AskAnswer; requireOwnership?: true }, operationId: string): Result;
  get(viewer: Viewer, input: { id: string }): Result;
  reportStatus(viewer: Viewer, input: Omit<AgentStatus, 'changedAt'>, operationId: string): Result;
}
export function attentionRole(operations: Pick<Operations, 'call'>): Attention {
  return {
    privateReply: (ctx, input) => privateReplies.get(operations)?.(ctx, input) ?? failure('unavailable', 'Private reply source is unavailable'),
    raise: (viewer, input, id) => operations.call('direct', viewer, 'attention.raise', input, id),
    resolve: (viewer, input, id) => operations.call('direct', viewer, 'attention.resolve', input, id),
    answer: (viewer, input, id) => operations.call('direct', viewer, 'attention.answer', input, id),
    get: (viewer, input) => operations.call('direct', viewer, 'attention.get', input),
    reportStatus: (viewer, input, id) => operations.call('direct', viewer, 'attention.reportStatus', input, id),
  };
}

/** Trusted daemon composition only. These capabilities never cross registry doors.
 * Source asks are household-only and answered in the enclosing write transaction.
 */
export interface HouseholdAskSource {
  raise(ctx: Context, input: Omit<Question, 'waits_on'> & { id: string }): void;
  resolve(ctx: Context, id: string, reason: string): void;
}
export const taskAskId = (id: string) => `task:${createHash('sha256').update(id, 'utf16le').digest('hex')}`;
export interface TaskAskFiling {
  /** Complete owning snapshot; the source controls wording, state and exact audience. */
  sync(ctx: Context, asks: Array<Omit<RaiseAsk, 'source'> & {active:boolean}>): void;
  /** Read-only projection comparison; no receipt or live publication. */
  pending(ctx: Context, asks: Array<Omit<RaiseAsk, 'source'> & {active:boolean}>): boolean;
}
export const approvalAskId = (id: string) => `approval:${createHash('sha256').update(id, 'utf16le').digest('hex')}`;
export interface ApprovalAskFiling {
  sync(ctx: Context, asks: Array<Omit<RaiseAsk, 'source'> & {active:boolean}>): void;
  pending(ctx: Context, asks: Array<Omit<RaiseAsk, 'source'> & {active:boolean}>): boolean;
}
export interface AttentionSources {
  /** Approval decisions stay in their owning window operation. */
  approvals(): ApprovalAskFiling;
  /** Task decisions remain in Tasks; this never creates an answer capability. */
  tasks(): TaskAskFiling;
  register(name: string, answer: (ctx: Context, ask: Ask) => void): HouseholdAskSource;
}

/** Offline source importers share the caller's transaction; no registry/authentication is installed. */
export function prepareAttentionImport(db: Db): void { migrate(db, 'attention', schema); }
