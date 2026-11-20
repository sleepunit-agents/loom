import type { Viewer } from '../../../core/index.js';
import type { Wake } from '../store.js';
/** Only a definite rejection before starting may be retried. A thrown call is uncertain. */
export type StartResult = { state: 'started'; body: string } | { state: 'not-started'; reason: string; retryAt?: number; code?: 'quota'; retryAfter?: unknown } | { state: 'held' | 'uncertain'; reason: string };
export interface Runtime { startBody(input: { wake: Wake; viewer: Viewer; intent: string }): Promise<StartResult> }
/** Replace this seam with the frame's hold function when it lands; no external work escapes staging. */
export const stagingRuntime = (): Runtime => ({ async startBody() { return { state: 'held', reason: 'Staging: body start held for a person' }; } });
