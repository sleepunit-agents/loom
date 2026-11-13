import type { Viewer } from '../../../core/index.js';
export interface Answer { state: 'pending' | 'allowed' | 'denied' | 'expired'; kind?: string; target?: string; instruction?: string }
/** Reads must enforce the request's visibility for viewer; never use a clock-wide credential. */
export interface Approvals {
  check(id: string, viewer: Viewer): Answer | undefined;
  subscribe(changed: () => void): () => void;
}
