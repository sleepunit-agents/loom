/** What a live read answers, as a page holds it: types only. */
export interface LiveRecord { id: string; [key: string]: unknown }
export type Status = 'loading' | 'live' | 'offline' | 'denied';
export type Failure = { ok: false; code: 'denied' | 'not-found' | 'invalid' | 'conflict' | 'unavailable'; message: string };
export interface Snapshot<T = LiveRecord> { records: readonly T[]; status: Status; error?: Failure }
