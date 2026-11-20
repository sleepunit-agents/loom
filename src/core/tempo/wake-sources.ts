import { randomUUID } from 'node:crypto';
import type { Change } from '../../pieces/changes/model.js';
import type { DataDatabase } from '../data/database.js';

export type WakeSource =
  | { kind: 'change'; id: string; change: Change; readAt: number; order: WakeReadOrder }
  | { kind: 'job' | 'approval' | 'question' | 'agent-removed' | 'member-removed'; id: string };

const observers = new WeakMap<DataDatabase['$client'], (event: WakeSource) => void>();

export function observeWakeSources(db: DataDatabase, observer: (event: WakeSource) => void): () => void {
  observers.set(db.$client, observer);
  return () => { observers.delete(db.$client); };
}

/** Called by the source writer before committing its transaction. */
export function wakeSource(db: DataDatabase, event: WakeSource): void {
  const observer = observers.get(db.$client);
  if (!observer) return;
  if (!db.$client.inTransaction) throw new Error('A wake source must own a transaction');
  observer(event);
}


type WakeReadOrder = { process: string; sequence: number };
const processId = randomUUID();
let sequence = 0;

/** Order reads begun in the same clock tick, before either reader awaits the forge. */
export const wakeReadOrder = (): WakeReadOrder => ({ process: processId, sequence: ++sequence });
