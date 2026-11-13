import type { Viewer } from '../../../core/index.js';
export type AnswerState = 'pending' | 'allowed' | 'granted' | 'denied' | 'expired' | 'used' | 'withdrawn' | 'cancelled' | 'unknown';
export interface Answer { state: AnswerState; kind?: string; target?: string; instruction?: string }
/** Reads must enforce the request's visibility for viewer; never use a clock-wide credential. */
export interface Approvals {
  check(id: string, viewer: Viewer): Answer | undefined;
  subscribe(changed: () => void): () => void;
}
