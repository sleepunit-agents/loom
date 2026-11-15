import type { DataDatabase } from '../data/database.js';
import type { Clock } from '../clock.js';
import { SettledInbox, type AdmitInbox } from './settle.js';
import { TriggerEngine, type Trigger } from './triggers.js';
import { Sweep } from './sweep.js';
import { TempoSources } from './sources.js';

/** Structural slice of Conversations: built-ins share one service/connection.
 * Kept small so Tempo does not own Inbox or conversation lifecycle. */
export interface TempoConversations {
  open(input: { agent: string; venue: 'wake'; place: string; label: string; project?: string | null }): { id: string };
  send(input: { toKind: 'person' | 'agent'; to: string; conversation?: string; source: 'trigger' | 'notice'; sourceId: string;
    fromKind: 'schedule'; fromId?: string; words: string; project?: string | null; agent?: string; member?: string; refs?: string[] }): unknown;
}
export interface TempoOptions {
  conversations: TempoConversations;
  admit: AdmitInbox;
  /** Commit a synchronous built-in operation on this same database. */
  operation(name: string, trigger: Trigger, occurrence: string): void;
  instructions?(file: string): string;
  /** Read Changes' persisted occurrence revision during source recovery. */
  changeRevision?(id: string): string | undefined;
  /** Publish committed table changes to the generated query subscriptions. */
  changed?(): void;
}

export function createTempo(db: DataDatabase, clock: Clock, options: TempoOptions) {
  let closed = false;
  const settled = new SettledInbox(db, clock, options.admit, options.changed);
  const sweep = new Sweep(clock, delivery => {
    const conversation = delivery.who.kind === 'agent' ? options.conversations.open({ agent: delivery.who.id, venue: 'wake', place: `sweep:${delivery.who.id}`, label: 'The sweep' }).id : undefined;
    options.conversations.send({ toKind: delivery.who.kind, to: delivery.who.id, conversation, source: 'notice', sourceId: delivery.id, fromKind: 'schedule', member: delivery.who.kind === 'person' ? delivery.who.id : undefined, words: delivery.words });
  });
  const engine = new TriggerEngine(db, clock, {
    inbox(t, occurrence, words) {
      const conversation = t.toKind === 'agent' ? options.conversations.open({ agent: t.to!, venue: 'wake', place: t.id, label: t.note, project: t.project }).id : undefined;
      options.conversations.send({ toKind: t.toKind!, to: t.to!, conversation, source: 'trigger', sourceId: occurrence,
        fromKind: 'schedule', fromId: t.owner ?? undefined, member: t.toKind === 'person' ? t.to! : undefined, words, project: t.project, agent: t.toKind === 'agent' ? t.to! : undefined, refs: [t.id] });
    },
    operation(name, t, occurrence) {
      if (name === 'tempo.sweep') {
        if (!t.toKind || !t.to) throw new Error('A sweep needs a recipient');
        sweep.run({ kind: t.toKind, id: t.to }, occurrence);
      } else options.operation(name, t, occurrence);
    },
    instructions: options.instructions,
    changed() { if (closed) return; settled.changed(); if (!closed) options.changed?.(); },
  });
  const sources = new TempoSources(db, engine);
  return {
    triggers: engine, inbox: settled, volume: settled.volume, sweep, sources,
    /** Start after all sweep contributors and operation targets are installed. */
    start() { if (closed) return; sources.recover(options.changeRevision); if (!closed) engine.tick(); },
    /** Call after committed Inbox writes or a runtime capacity change. */
    changed() { if (closed || db.$client.inTransaction) return; settled.changed(); if (!closed) options.changed?.(); },
    /** Shared writer's post-commit hook: recover watched source outcomes, then
     * rescan trigger configuration, quiet deadlines and waiting inbox batches.
     * Never call this from a provisional savepoint or inside an operation.
     */
    committed() {
      if (closed) return;
      if (db.$client.inTransaction) throw new Error('Refresh Tempo after commit');
      sources.recover(options.changeRevision);
      if (!closed) engine.tick();
    },
    close() { closed = true; sources.close(); engine.close(); settled.close(); },
  };
}
