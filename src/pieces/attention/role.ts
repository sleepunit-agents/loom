/** The desk's seam. Other pieces raise/resolve asks here, never in their own tables. */
import type { Operations, Result, Scope, Viewer } from '../../core/index.js';

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
  state: 'open' | 'answered' | 'resolved';
  createdAt: number;
  changedAt: number;
  answer?: AskAnswer & { by: Viewer; at: number };
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
 * Only answer writes answer.by; first answer wins. Agents cannot answer person asks.
 */
export interface Attention {
  raise(viewer: Viewer, input: RaiseAsk, operationId: string): Result;
  resolve(viewer: Viewer, input: { id: string; reason: string }, operationId: string): Result;
  answer(viewer: Viewer, input: { id: string; answer: AskAnswer }, operationId: string): Result;
  get(viewer: Viewer, input: { id: string }): Result;
  reportStatus(viewer: Viewer, input: Omit<AgentStatus, 'changedAt'>, operationId: string): Result;
}
export function attentionRole(operations: Pick<Operations, 'call'>): Attention {
  return {
    raise: (viewer, input, id) => operations.call('direct', viewer, 'attention.raise', input, id),
    resolve: (viewer, input, id) => operations.call('direct', viewer, 'attention.resolve', input, id),
    answer: (viewer, input, id) => operations.call('direct', viewer, 'attention.answer', input, id),
    get: (viewer, input) => operations.call('direct', viewer, 'attention.get', input),
    reportStatus: (viewer, input, id) => operations.call('direct', viewer, 'attention.reportStatus', input, id),
  };
}
