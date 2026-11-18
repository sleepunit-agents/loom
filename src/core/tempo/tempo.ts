import type { OnWord } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import type { Clock } from '../clock.js';
import { SettledInbox, type AdmitInbox } from './settle.js';
import { TriggerEngine, type Trigger } from './triggers.js';
import { Sweep } from './sweep.js';
import { TempoSources } from './sources.js';

/** Structural slice of Conversations: built-ins share one service/connection.
 * Kept small so Tempo does not own Inbox or conversation lifecycle. */
export interface TempoConversations {
  open(input: { agent: string; venue: 'wake'; place: string; label: string; project?: string | null; member?: string }): { id: string; member?: string | null };
  send(input: { toKind: 'person' | 'agent'; to: string; conversation?: string; source: 'trigger' | 'notice'; sourceId: string;
    fromKind: 'schedule'; fromId?: string; words: string; project?: string | null; agent?: string; member?: string; refs?: string[];
    onWordKind?: OnWord['kind']; onWord?: string }): unknown;
}
export interface TempoOptions {
  conversations: TempoConversations;
  admit: AdmitInbox;
  /** Commit a synchronous built-in operation on this same database. */
  operation(name: string, trigger: Trigger, occurrence: string): void;
  /** Names of further operations the composition can run, beside tempo.sweep. */
  knows?(name: string): boolean;
  instructions?(file: string): string;
  /** The member a firing of this trigger is private work for, or nobody when it is the agent's own
   * (read from `triggers.member`; src/shared-tempo.ts). Throws when that member may no longer be worked for; the firing then
   * fails. Without it every firing is the agent's own. */
  worksFor?(trigger: Trigger): string | undefined;
  /** For a trigger that names a conversation, asked as it fires: either why it can no longer fire (its
   * asker is no longer known, or the conversation is gone or cannot be posted to) and whom to tell, or how
   * its mail is sent: the words it is told under and the person on whose word. Without it such a trigger fails. */
  placeFiring?(trigger: Trigger): { stop: string; tell: string[] } | { told: string; onWord?: OnWord };
  /** Read Changes' persisted occurrence revision during source recovery. */
  changeRevision?(id: string): string | undefined;
  /** Publish committed table changes to the generated query subscriptions. */
  changed?(): void;
}

/** The place of the conversation a trigger's firings run in: the trigger, and for a member's private work
 * the member too. The one statement of it, for the firing and for whoever reads a trigger back from a
 * conversation (the dispatcher, for the model a lane wants). */
export const wakePlace = (trigger: string, member?: string): string => member === undefined ? trigger : `${trigger}:for:${member}`;
/** The trigger ids a wake conversation's place may name: itself, and what stands before `:for:`. */
export const wakePlaceTriggers = (place: string): string[] => { const at = place.lastIndexOf(':for:'); return at > 0 ? [place, place.slice(0, at)] : [place]; };

export function createTempo(db: DataDatabase, clock: Clock, options: TempoOptions) {
  let closed = false;
  const settled = new SettledInbox(db, clock, options.admit, options.changed);
  const sweep = new Sweep(clock, delivery => {
    const conversation = delivery.who.kind === 'agent' ? options.conversations.open({ agent: delivery.who.id, venue: 'wake', place: `sweep:${delivery.who.id}`, label: 'The sweep' }).id : undefined;
    options.conversations.send({ toKind: delivery.who.kind, to: delivery.who.id, conversation, source: 'notice', sourceId: delivery.id, fromKind: 'schedule', member: delivery.who.kind === 'person' ? delivery.who.id : undefined, words: delivery.words });
  });
  const engine = new TriggerEngine(db, clock, {
    inbox(t, occurrence, words) {
      // A trigger that names a conversation is mail there, on its asker's word, and opens no wake. One that
      // can no longer fire is stopped here, in the firing's transaction, and its agent's owners are told once.
      if (t.conversation) {
        if (!options.placeFiring) throw new Error('This program cannot fire a trigger into a conversation');
        const how = options.placeFiring(t);
        if ('stop' in how) {
          for (const member of how.tell) options.conversations.send({ toKind: 'person', to: member, member, source: 'notice', sourceId: `place-trigger-stopped:${occurrence}`, fromKind: 'schedule',
            words: `The schedule ${JSON.stringify(t.note)} was stopped and did not fire: ${how.stop}.`, refs: [t.id] });
          return 'stop';
        }
        options.conversations.send({ toKind: 'agent', to: t.to!, conversation: t.conversation, source: 'trigger', sourceId: occurrence, fromKind: 'schedule', fromId: t.owner ?? undefined,
          words: `${how.told}\n\n${words}`, agent: t.to!, refs: [t.id], ...(how.onWord ? { onWordKind: how.onWord.kind, onWord: how.onWord.id } : {}) });
        return;
      }
      // Work for a member is that member's private conversation with the agent, so the job it starts is
      // theirs (runtime/jobs.ts copies the conversation's member). It has its own place: the trigger's
      // own conversation, if it has fired as the agent's before, stays the agent's.
      const member = t.toKind === 'agent' ? options.worksFor?.(t) : undefined;
      const opened = t.toKind === 'agent' ? options.conversations.open({ agent: t.to!, venue: 'wake', place: wakePlace(t.id, member), label: t.note, project: t.project, ...(member === undefined ? {} : { member }) }) : undefined;
      // A place is found, not made, when it exists. One that is somebody else's must not take this work.
      if (opened && (opened.member ?? undefined) !== member) throw new Error('The conversation at this trigger\'s place belongs to other work');
      const conversation = opened?.id;
      options.conversations.send({ toKind: t.toKind!, to: t.to!, conversation, source: 'trigger', sourceId: occurrence,
        fromKind: 'schedule', fromId: t.owner ?? undefined, member: t.toKind === 'person' ? t.to! : member, words, project: t.project, agent: t.toKind === 'agent' ? t.to! : undefined, refs: [t.id] });
    },
    operation(name, t, occurrence) {
      // An operation gathers by the agent's whole reach; it is not a member's to fire (policy.ts, "Scheduled work").
      if (options.worksFor?.(t) !== undefined) throw new Error('A member who is not a household owner schedules words for an agent, not an operation');
      if (name === 'tempo.sweep') {
        if (!t.toKind || !t.to) throw new Error('A sweep needs a recipient');
        sweep.run({ kind: t.toKind, id: t.to }, occurrence);
      } else options.operation(name, t, occurrence);
    },
    // Without a list from the composition, any name it handles is taken on trust, as before.
    knows: name => name === 'tempo.sweep' || (options.knows ? options.knows(name) : true),
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
