import type { Change } from '../../pieces/changes/model.js';
import type { DataDatabase } from '../data/database.js';

export type WakeSource =
  | { kind: 'change'; id: string; change: Change; readAt: number }
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
