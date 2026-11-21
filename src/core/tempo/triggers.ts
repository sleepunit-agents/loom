import { houseProgramSchema, type HouseProgram } from '../../runtime/house-program.js';
import { machineFacts } from '../../runtime/machine-facts.js';
import type { Asker } from '../../policy.js';
import { randomUUID } from 'node:crypto';
import { laneFile } from './lane-file.js';
import { and, eq, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../data/database.js';
import { agentPauses, programFirings, triggerEdits, triggerLog, triggers } from '../data/schema.js';
import type { Clock } from '../clock.js';
import { householdTimezone } from '../data/household-settings.js';
import { localDate, nextTime } from './calendar.js';
import { MESSAGE_WORDS_MAX } from '../conversations/words.js';

export type Trigger = typeof triggers.$inferSelect;
const text = z.string().min(1);
const placement = { needs: machineFacts.nullish(), prefers: machineFacts.nullish() };
export const HOST_SCHEDULE_REFUSAL = 'Host execution is unavailable for scheduled work. Schedule a container job or use an approved machine read.';
export const triggerInput = z.object({
  execution: z.enum(['container', 'host']).optional(),
  id: text.optional(), ownerKind: z.enum(triggers.ownerKind.enumValues), owner: text.nullable().optional(),
  sourceKind: z.enum(['time', 'pull-request', 'answer', 'job']), watches: text.nullable().optional(),
  times: text.nullable().optional(), days: text.nullable().optional(), lifespan: z.enum(['until-stopped', 'today', 'once']),
  targetKind: z.enum(triggers.targetKind.enumValues), target: text.nullable().optional(),
  toKind: z.enum(triggers.toKind.enumValues).nullable().optional(), to: text.nullable().optional(), project: text.nullable().optional(),
  instructions: z.string().max(MESSAGE_WORDS_MAX).nullable().optional(), file: text.nullable().optional(), note: text.max(MESSAGE_WORDS_MAX),
  /** The kind of model the work should run on: a tag such as best, normal or low, or one model by name. */
  wantsModel: text.max(200).nullable().optional(),
  program: houseProgramSchema.omit({ state: true, payload: true }).nullish(),
  programPeriod: z.literal('day').nullish(),
  readStateFrom: text.nullish(),
  ...placement,
  /** The Discord or Slack conversation a firing is mail in, instead of a wake of its own. */
  conversation: text.nullable().optional(),
});
export type NewTrigger = z.input<typeof triggerInput>;
/** The parts of a standing trigger that can change after it is set. Who it is for, what it
 * watches and what it does cannot: stop it and set another. */
export const triggerEdit = z.object({
  ...placement,
  instructions: z.string().max(MESSAGE_WORDS_MAX).nullable().optional(), file: text.nullable().optional(),
  times: text.optional(), days: text.nullable().optional(), note: text.max(MESSAGE_WORDS_MAX).optional(), wantsModel: text.max(200).nullable().optional(),
}).strict();
export type TriggerEdit = z.input<typeof triggerEdit>;
/** Which of a trigger's words an edit changes. A trigger's words are its note, which a firing into a conversation
 * quotes to the body, and what it says: its instructions, or the file they are read from. Changed means different
 * from what is stored: words sent back as they stand are not changed, whoever sends them. Read as the engine
 * applies an edit: giving the instructions drops the file, and giving a file drops the instructions. */
export function wordsChanged(change: WordsEdit, stored: StoredWords): { note: boolean; said: boolean } {
  const instructions = change.instructions !== undefined ? change.instructions : change.file != null ? null : stored.instructions ?? null;
  const file = change.file !== undefined ? change.file : change.instructions != null ? null : stored.file ?? null;
  return { note: change.note !== undefined && change.note !== stored.note, said: instructions !== (stored.instructions ?? null) || file !== (stored.file ?? null) };
}
export type WordsEdit = { instructions?: string | null; file?: string | null; note?: string };
export type StoredWords = { instructions?: string | null; file?: string | null; note?: string };
/** Whether an edit changes what a firing says. The one statement: whoever changes any of a trigger's words becomes
 * the asker, and may not where the words would go into another member's private conversation. Times, days and the
 * wanted model are not words, and neither are words sent unchanged. */
export const editsWords = (change: WordsEdit, stored: StoredWords): boolean => { const changed = wordsChanged(change, stored); return changed.note || changed.said; };
/** What a rule about where a caller works is asked of a trigger: what the caller sent for a new one, or the
 * stored row. The one shape for the door (operations.ts, wordRefusal) and the rule (src/shared-place-triggers.ts). */
export type TriggerAsked = { id?: string; conversation?: string | null; times?: string | null; lifespan?: string; sourceKind?: string; file?: string | null; instructions?: string | null; note?: string; askedByKind?: string | null; askedBy?: string | null };
export interface TriggerEffects {
  /** Synchronous shared-database writes only; both callbacks run in the trigger's
   * transaction. The delivery id is the inbox source_id. Never start a body. */
  /** `stop`: the trigger can no longer fire and is stopped with this firing. */
  inbox(trigger: Trigger, deliveryId: string, words: string): void | 'stop';
  operation(name: string, trigger: Trigger, deliveryId: string): void;
  /** Admit a program job on the shared connection. The firing binds its frozen input to that job. */
  program?(trigger: Trigger, words: string): string | undefined;
  /** Whether an operation target names something this program can run. Checked when a trigger is set. */
  knows?(name: string): boolean;
  /** Resolve relative household repository files; no runtime home is read here. */
  instructions?(file: string): string;
  changed?(): void;
}

/** How late a standing time trigger may still fire. See "Missed times" on TriggerEngine. */
export const MISSED_GRACE_MS = 5 * 60_000;
/** How many skipped times of one gap get a log row each; the rest share one row that counts them. */
export const MISSED_ROWS = 20;
/** How many skipped times are counted one by one before the count is given as "more than". */
const MISSED_COUNTED = 5_000;

/** Source adapters report PR changes, answered approvals/questions/secrets and
 * stopped jobs here. Time deadlines are driven by the injected clock.
 *
 * Missed times. A time can pass unfired because the trigger's agent was paused, the program was not
 * running or the clock jumped. What happens then depends on what the trigger is for:
 * - A standing trigger (one that repeats: `until-stopped` or `today`) fires at its time, or up to
 *   MISSED_GRACE_MS after it. A time further behind than that is skipped, not fired late: the log says
 *   `missed`, and the trigger moves to its next listed time. So a 09:00 lane never runs at 14:00 because
 *   the server came back then, and nothing fires twice to catch up.
 *   The next listed time is always the one after the time just fired or skipped, never the one after
 *   now, so every listed time a gap swallowed meets this same rule in turn: with 09:00 and 09:03 listed
 *   and the server back at 09:04, both fire; back at 09:40, both are logged `missed`.
 * - A once-only trigger is a thing that is meant to happen once. It fires late, however late, as soon as
 *   it can, and is never dropped. Running it by hand is that one firing: its time does not fire after.
 * Running a standing trigger by hand leaves its times as they are.
 * A step of the host's wall clock while the program runs follows from the same rule. The clock reads
 * the wall again at least every STEP_CHECK_MS (core/clock.ts), so a time that comes after a forward
 * step is reached while the engine is looking and fires at its time: it came due while the program was
 * running and able to fire, and is not missed. A time the step passed over never came on this
 * program's clock; it is found behind at the next look and meets the rule above (fired if within the
 * grace, else `missed`), exactly as if the program had been down for that long.
 * Two other ways a time passes are not misses. A trigger that is off has no times, so turning it on (or
 * changing its times) starts from now, and a once-only trigger whose time passed while it was off cannot
 * be turned on again. A firing that fails has used its time, is logged `failed` with the stage, and is
 * not tried again.
 * Events (an answer, a job, a pull request) are not times: one seen while held fires on resume.
 *
 * Listed times are wall times in the household's timezone. When that changes while the program runs,
 * every standing trigger's next time is worked out again from now in the new zone (logged `rezoned`). */
export class TriggerEngine {
  private cancel?: () => void;
  private closed = false;
  private ticking = false;
  private again = false;
  /** The timezone the stored next times were last checked against; unknown until the first scan, so a
   * change made while the program was down is not seen (docs/accepted-tradeoffs.md, "A timezone change
   * while loom is down is seen one firing late"). */
  private zoned?: string;
  constructor(private db: DataDatabase, private clock: Clock, private effects: TriggerEffects) {}
  private open() { if (this.closed) throw new Error('Tempo is closed'); }
  private now() { return new Date(this.clock.now()).toISOString(); }
  private zone() { return householdTimezone(this.db); }
  private log(id: string, event: string, note = '') {
    const seq = (this.db.select({ seq: max(triggerLog.seq) }).from(triggerLog).get()?.seq ?? 0) + 1;
    this.db.insert(triggerLog).values({ seq, trigger: id, at: this.now(), event, note }).run();
  }
  private get(id: string) {
    const t = this.db.select().from(triggers).where(eq(triggers.id, id)).get();
    if (!t) throw new Error('Trigger not found');
    return t;
  }
  private agent(t: Trigger) { return t.toKind === 'agent' ? t.to : !t.toKind && t.ownerKind === 'agent' ? t.owner : null; }
  private paused(t: Trigger) {
    const agent = this.agent(t);
    return !!agent && !!this.db.select().from(agentPauses).where(eq(agentPauses.agent, agent)).get();
  }
  /** `member` is whom the trigger's work is for, when that is a member and not the agent itself; `asked` is
   * who asked for a trigger that names a conversation. Both are the door's to say (shared-tempo-access.ts,
   * shared-place-triggers.ts) and never part of what a caller sends. */
  set(value: NewTrigger, member?: string, asked?: Asker): Trigger {
    this.open();
    const { execution, ...v } = triggerInput.parse(value);
    if (execution === 'host') throw new Error(HOST_SCHEDULE_REFUSAL);
    if (member !== undefined && v.toKind !== 'agent') throw new Error('Only a trigger that puts an agent to work is for a member');
    if ((v.ownerKind === 'household') !== !v.owner) throw new Error('Trigger needs its owner');
    if (!!v.toKind !== !!v.to) throw new Error('A recipient needs both kind and id');
    if (v.targetKind === 'inbox' && (!v.toKind || !v.to)) throw new Error('Inbox target needs a recipient');
    if (v.targetKind === 'operation' && !v.target) throw new Error('Operation target needs a name');
    if (v.targetKind === 'operation' && this.effects.knows && !this.effects.knows(v.target!)) throw new Error('Unknown operation');
    if (v.sourceKind !== 'time' && !v.watches) throw new Error('Event trigger needs what it watches');
    if (v.file && !laneFile(v.file)) throw new Error('Instructions must be a relative repository file');
    if (v.file && v.instructions) throw new Error('Give instructions or a file');
    if (!!v.conversation !== !!asked) throw new Error('A trigger that names a conversation records who asked, and no other does');
    if (v.conversation && (v.targetKind !== 'inbox' || v.toKind !== 'agent' || member !== undefined)) throw new Error('A trigger that names a conversation is mail for its agent');
    if (!v.program && (v.programPeriod || v.readStateFrom)) throw new Error('A program is required for state or period');
    if (v.program) {
      if (v.sourceKind !== 'time') throw new Error('Only a time schedule can run a program');
      if (v.targetKind !== 'inbox' || v.toKind !== 'agent' || v.ownerKind !== 'agent' || v.owner !== v.to || member || v.conversation)
        throw new Error('A program is scheduled as its agent’s own work');
      if (v.readStateFrom) {
        const producer = this.get(v.readStateFrom);
        if (!producer.program || producer.to !== v.to || producer.project !== (v.project ?? null)) throw new Error('State must come from a program for the same agent and project');
      }
    }
    const due = this.due(v.sourceKind, v.times, v.days, v.lifespan);
    const id = v.id ?? `tr-${randomUUID()}`;
    this.db.transaction(() => {
      this.db.insert(triggers).values({ ...v, id, member: member ?? null, conversation: v.conversation ?? null, ...(asked ? { askedByKind: asked.kind, askedBy: asked.id, askedAt: this.now() } : {}), enabled: true, state: 'standing', nextDueAt: due, createdAt: this.now(), changedAt: this.now() }).run();
      if (this.paused(this.get(id))) this.db.update(triggers).set({ state: 'held' }).where(eq(triggers.id, id)).run();
      this.log(id, 'set');
    });
    this.tick(); return this.get(id);
  }
  stop(id: string, occurrence?: { agent: string; at?: string }): void {
    this.open();
    this.db.transaction(() => {
      const trigger = this.get(id);
      if (occurrence) {
        if (!trigger.enabled || trigger.state === 'firing' || this.agent(trigger) !== occurrence.agent ||
          (occurrence.at !== undefined && trigger.nextDueAt !== occurrence.at))
          throw Error('This wake is no longer pending on that clock');
        if (trigger.lifespan !== 'once') {
          if (!occurrence.at || trigger.sourceKind !== 'time') throw Error('Select a pending occurrence of the schedule');
          const after = Math.max(this.clock.now(), Date.parse(occurrence.at));
          const next = this.expired(trigger) ? undefined : this.following(trigger, after);
          this.log(id, 'cancelled', 'time:' + occurrence.at);
          if (next !== undefined) {
            this.db.update(triggers).set({ nextDueAt: new Date(next).toISOString(), changedAt: this.now() })
              .where(eq(triggers.id, id)).run();
            return;
          }
        }
      }
      this.db.update(triggers).set({ enabled: false, state: 'stopped', nextDueAt: null, changedAt: this.now() }).where(eq(triggers.id, id)).run();
      this.log(id, 'stopped');
    });
    this.tick();
  }
  /** Turn a stopped trigger back on. Its next time is worked out from now: while it was off it had no times. */
  start(id: string): void {
    this.open();
    this.db.transaction(() => {
      const t = this.get(id);
      if (t.enabled) throw new Error('Trigger is already on');
      if (t.state !== 'stopped' && t.state !== 'failed') throw new Error('Only a stopped trigger can be started');
      if (this.expired(t)) throw new Error('No time left today');
      this.db.update(triggers).set({ enabled: true, state: this.paused(t) ? 'held' : 'standing', nextDueAt: this.due(t.sourceKind, t.times, t.days, t.lifespan), changedAt: this.now() }).where(eq(triggers.id, id)).run();
      this.log(id, 'started');
    });
    this.tick();
  }
  /** Change a trigger's words, times, label or wanted model, keeping what the changed parts said before and
   * who changed them. `asked` re-stamps who asked, for a trigger that names a conversation whose words or
   * file change: who that is is the door's to say (src/shared-tempo.ts, reasked), and whether anything changed is
   * asked here. */
  edit(id: string, change: TriggerEdit, by: { kind: 'member' | 'agent'; id: string }, asked?: Asker): void {
    this.open();
    const c = triggerEdit.parse(change);
    this.db.transaction(() => {
      const t = this.get(id);
      // Giving the words drops the file and giving a file drops the words: a trigger reads from one place.
      if (c.instructions != null && c.file === undefined) c.file = null;
      if (c.file != null && c.instructions === undefined) c.instructions = null;
      if (c.file && c.instructions) throw new Error('Give instructions or a file');
      if (c.file && !laneFile(c.file)) throw new Error('Instructions must be a relative repository file');
      if ((c.times !== undefined || c.days !== undefined) && t.sourceKind !== 'time') throw new Error('Only a time trigger has times');
      const before: Record<string, string | string[] | null> = {};
      for (const key of ['instructions', 'file', 'times', 'days', 'note', 'wantsModel'] as const) if (c[key] !== undefined && c[key] !== t[key]) before[key] = t[key];
      for (const key of ['needs', 'prefers'] as const) {
        if (c[key] !== undefined && JSON.stringify(c[key]) !== JSON.stringify(t[key])) before[key] = t[key];
      }
      if (!Object.keys(before).length) return;
      // The asker follows the words, and only words that are different now: asked here, where what changed is known,
      // so no door can re-stamp a trigger whose words it sent back unchanged.
      if (asked && t.conversation && ('instructions' in before || 'file' in before || 'note' in before)) this.db.update(triggers).set({ askedByKind: asked.kind, askedBy: asked.id, askedAt: this.now() }).where(eq(triggers.id, id)).run();
      const next = { ...t, ...c };
      const due = t.enabled && ('times' in before || 'days' in before) ? this.due(t.sourceKind, next.times, next.days, t.lifespan) : t.nextDueAt;
      this.db.update(triggers).set({ instructions: next.instructions, file: next.file, times: next.times, days: next.days, note: next.note, wantsModel: next.wantsModel, needs: next.needs, prefers: next.prefers, nextDueAt: due, changedAt: this.now() }).where(eq(triggers.id, id)).run();
      const seq = (this.db.select({ seq: max(triggerEdits.seq) }).from(triggerEdits).get()?.seq ?? 0) + 1;
      this.db.insert(triggerEdits).values({ seq, trigger: id, at: this.now(), byKind: by.kind, by: by.id, before: JSON.stringify(before) }).run();
      this.log(id, 'edited', Object.keys(before).join(', '));
    });
    this.tick();
  }
  private due(sourceKind: Trigger['sourceKind'], times: string | null | undefined, days: string | null | undefined, lifespan: Trigger['lifespan']): string | null {
    if (sourceKind !== 'time') return null;
    if (!times) throw new Error('Time trigger needs a time');
    const at = nextTime(times, days ?? null, this.clock.now() - 1, this.zone());
    if (!Number.isFinite(at)) throw new Error('Time is in the past');
    if (lifespan === 'today' && localDate(at, this.zone()) !== localDate(this.clock.now(), this.zone())) throw new Error('No time left today');
    return new Date(at).toISOString();
  }
  pause(agent: string): void {
    this.open();
    this.db.transaction(() => {
      this.db.insert(agentPauses).values({ agent, since: this.now() }).onConflictDoNothing().run();
      for (const t of this.active().filter(t => this.agent(t) === agent && t.state !== 'held')) {
        this.db.update(triggers).set({ state: 'held', changedAt: this.now() }).where(eq(triggers.id, t.id)).run(); this.log(t.id, 'held');
      }
    }); this.tick();
  }
  resume(agent: string): void {
    this.open();
    this.db.transaction(() => {
    this.db.delete(agentPauses).where(eq(agentPauses.agent, agent)).run();
    for (const t of this.active().filter(t => this.agent(t) === agent && t.state === 'held')) {
      this.db.update(triggers).set({ state: 'standing', changedAt: this.now() }).where(eq(triggers.id, t.id)).run(); this.log(t.id, 'resumed');
    }
    }); this.tick();
  }
  event(kind: Exclude<Trigger['sourceKind'], 'time'>, watches: string, eventId: string): void {
    this.open();
    if (!eventId) throw new Error('Source event needs an identifier');
    this.db.transaction(() => {
      for (const t of this.active().filter(t => t.sourceKind === kind && t.watches === watches)) {
        if (this.db.select().from(triggerLog).where(and(eq(triggerLog.trigger, t.id), eq(triggerLog.event, 'observed'), eq(triggerLog.note, eventId))).get()) continue;
        this.log(t.id, 'observed', eventId);
      }
    }); this.tick();
  }
  runNow(id: string): void {
    this.open();
    const t = this.get(id);
    if (!t.enabled || this.paused(t)) throw new Error('Trigger is stopped or held');
    this.fire(t, `manual:${randomUUID()}`); this.tick();
  }
  private active() { return this.db.select().from(triggers).where(eq(triggers.enabled, true)).all(); }
  private expired(t: Trigger) { return t.lifespan === 'today' && localDate(Date.parse(t.createdAt), this.zone()) !== localDate(this.clock.now(), this.zone()); }
  /** Startup recovery and source/clock changes. No polling or model required. */
  tick(): void {
    if (this.closed) return;
    // Built-in operations can change triggers in the firing transaction. Finish
    // that transaction before another scan can observe or fire its rows.
    if (this.ticking) { this.again = true; return; }
    // A command may still be saving its receipt in the shared outer
    // transaction. Its commit hook will rescan; a rollback must not admit work
    // or publish provisional data, or replace the last committed timer.
    if (this.db.$client.inTransaction) return;
    this.ticking = true;
    try {
      do { this.again = false; this.scan(); } while (this.again && !this.closed);
    } finally { this.ticking = false; }
    if (!this.closed) this.effects.changed?.();
  }
  /** Move every standing wall-time trigger to its next time in the household's present timezone. The
   * times it had were in the old zone's hours, so none of them is fired or counted as missed. */
  private rezone(): void {
    this.db.transaction(() => {
      for (const t of this.active().filter(t => t.sourceKind === 'time' && t.times && !/^\d{4}-/.test(t.times))) {
        const next = this.following(t, this.clock.now() - 1);
        const nextDueAt = next === undefined ? null : new Date(next).toISOString();
        if (nextDueAt === t.nextDueAt) continue;
        this.db.update(triggers).set(next === undefined ? { enabled: false, state: 'stopped', nextDueAt, changedAt: this.now() } : { nextDueAt, changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
        this.log(t.id, 'rezoned');
      }
    });
  }
  private scan(): void {
    this.cancel?.(); this.cancel = undefined;
    let next: number | undefined;
    const zone = this.zone();
    if (this.zoned !== undefined && this.zoned !== zone) this.rezone();
    this.zoned = zone;
    for (const entry of this.active()) {
      if (this.closed) return;
      // An earlier operation in this scan may have stopped or paused this row.
      const t = this.get(entry.id);
      if (!t.enabled) continue;
      if (this.expired(t)) { this.stopExpired(t); continue; }
      if (t.lifespan === 'today') {
        // First instant of the next local date; scan at most a DST day.
        const zone = this.zone(), today = localDate(this.clock.now(), zone);
        let end = this.clock.now() + 26 * 3_600_000, start = this.clock.now();
        while (end - start > 1) { const mid = Math.floor((start + end) / 2); if (localDate(mid, zone) === today) start = mid; else end = mid; }
        next = Math.min(next ?? Infinity, end);
      }
      if (this.paused(t)) continue;
      if (t.sourceKind === 'time') {
        const late = t.nextDueAt ? this.clock.now() - Date.parse(t.nextDueAt) : -1;
        // The missed-time rule on the class: only a standing trigger's time can be too late to fire.
        if (late >= 0 && (late <= MISSED_GRACE_MS || t.lifespan === 'once')) this.fire(t, `time:${t.nextDueAt}`, Date.parse(t.nextDueAt!));
        else if (late > MISSED_GRACE_MS) this.miss(t);
      } else {
        const logs = this.db.select().from(triggerLog).where(eq(triggerLog.trigger, t.id)).all();
        const consumed = new Set(logs.filter(l => ['fired', 'failed'].includes(l.event)).map(l => l.note));
        for (const log of logs.filter(l => l.event === 'observed' && !consumed.has(l.note))) {
          if (this.closed) return;
          const current = this.get(t.id);
          if (current.enabled && !this.paused(current)) this.fire(current, log.note);
        }
      }
      if (this.closed) return;
      const current = this.get(t.id);
      if (!current.enabled || !current.nextDueAt || current.state === 'failed') continue;
      // A listed time that passed while an earlier one was fired or skipped is due already: it is judged
      // by the same rule on another pass, now, not when a timer gets round to it.
      if (current.sourceKind === 'time' && Date.parse(current.nextDueAt) <= this.clock.now() && !this.paused(current)) this.again = true;
      else next = Math.min(next ?? Infinity, Date.parse(current.nextDueAt));
    }
    if (!this.closed && next !== undefined) this.cancel = this.clock.at(next, () => this.tick());
  }
  private stopExpired(t: Trigger) {
    this.db.transaction(() => { this.db.update(triggers).set({ enabled: false, state: 'stopped', nextDueAt: null, changedAt: this.now() }).where(eq(triggers.id, t.id)).run(); this.log(t.id, 'stopped', 'today ended'); });
  }
  /** The listed time of a standing time trigger that follows `after`, or nothing when it has none left
   * (a `today` trigger's remaining times are tomorrow's). */
  private following(t: Trigger, after: number): number | undefined {
    const zone = this.zone(), next = nextTime(t.times!, t.days, after, zone);
    return Number.isFinite(next) && (t.lifespan !== 'today' || localDate(next, zone) === localDate(this.clock.now(), zone)) ? next : undefined;
  }
  /** Where a trigger stands once what it was due for is spent: whether it goes on, and when next. `spent`
   * is the listed time that was just fired or skipped; null for an event and for a firing made by hand,
   * which uses up none of a standing trigger's times. */
  private rest(t: Trigger, spent: number | null): { standing: boolean; nextDueAt: string | null } {
    if (t.lifespan === 'once') return { standing: false, nextDueAt: null };
    if (t.sourceKind !== 'time') return { standing: true, nextDueAt: null };
    if (spent === null) return { standing: true, nextDueAt: this.get(t.id).nextDueAt };
    const next = this.following(t, spent);
    return { standing: next !== undefined, nextDueAt: next === undefined ? null : new Date(next).toISOString() };
  }
  /** Skip every listed time of a standing trigger that is more than the grace behind: nothing is
   * delivered, and the trigger moves to the first listed time that is not. Each skipped time gets its
   * own `missed` row up to MISSED_ROWS; a longer gap ends in one row that counts the rest and names the
   * last, so a year of downtime is neither unrecorded nor a year of rows. */
  private miss(t: Trigger) {
    this.db.transaction(() => {
      const behind = (at: number) => this.clock.now() - at > MISSED_GRACE_MS;
      let last = Date.parse(t.nextDueAt!), skipped = 1, next = this.following(t, last);
      this.log(t.id, 'missed', `time:${t.nextDueAt}`);
      while (next !== undefined && behind(next) && skipped < MISSED_COUNTED) {
        last = next; skipped++; next = this.following(t, last);
        if (skipped <= MISSED_ROWS) this.log(t.id, 'missed', `time:${new Date(last).toISOString()}`);
      }
      const uncounted = next !== undefined && behind(next);
      // Past counting one by one: go straight to the first listed time the grace still covers.
      if (uncounted) next = this.following(t, this.clock.now() - MISSED_GRACE_MS - 1);
      if (skipped > MISSED_ROWS) this.log(t.id, 'missed', uncounted ? `more than ${skipped - MISSED_ROWS} more`
        : `${skipped - MISSED_ROWS} more, the last at time:${new Date(last).toISOString()}`);
      const standing = next !== undefined;
      this.db.update(triggers).set({ state: standing ? 'standing' : 'stopped', enabled: standing, nextDueAt: standing ? new Date(next!).toISOString() : null, changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
    });
  }
  /** Claim one program job and freeze the exact input its worker will receive in this firing's transaction.
   * An occupied conversation or pending program uses the time without taking the daily allowance. */
  private admitProgram(t: Trigger, program: NonNullable<Trigger['program']>, delivery: string): 'fired' | 'skipped' {
    const period = t.programPeriod === 'day' ? localDate(this.clock.now(), this.zone()) : null;
    const prior = (condition: ReturnType<typeof eq>) => this.db.select({ id: programFirings.id }).from(programFirings)
      .where(and(eq(programFirings.trigger, t.id), condition)).get();
    if (prior(eq(programFirings.status, 'pending')) || (period && prior(eq(programFirings.period, period)))) return 'skipped';
    if (!this.effects.program) throw new Error('No program runner');
    const words = t.file ? this.effects.instructions?.(t.file) : t.instructions ?? '';
    if (words === undefined) throw new Error('No repository instructions reader');
    const producer = this.db.select({ program: triggers.program, to: triggers.to, project: triggers.project, member: triggers.member,
      conversation: triggers.conversation, state: triggers.programState, hasState: sql<number>`${triggers.programState} is not null` })
      .from(triggers).where(eq(triggers.id, t.readStateFrom ?? t.id)).get();
    if (!producer?.program || producer.to !== t.to || producer.project !== t.project || producer.member || producer.conversation)
      throw new Error('Program state source is no longer available');
    const job = this.effects.program(t, words);
    if (!job) return 'skipped';
    this.db.insert(programFirings).values({ id: delivery, trigger: t.id, job, at: this.now(), period,
      program: { ...program, ...(producer.hasState ? { state: producer.state } : {}) }, status: 'pending' }).run();
    return 'fired';
  }
  /** `spent` is the listed time this firing uses up, or null for an event and for a firing made by hand. */
  private fire(t: Trigger, eventId: string, spent: number | null = null) {
    // What the firing was doing, for the log if it fails.
    let stage: 'operation' | 'instructions' | 'inbox' | 'program' = 'operation';
    try {
      this.db.transaction(() => {
        if (t.program && spent !== null) {
          const current = this.get(t.id);
          if (!current.enabled || current.nextDueAt !== t.nextDueAt) return;
        }
        this.db.update(triggers).set({ state: 'firing', changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
        const delivery = `${t.id}:${eventId}`;
        let event = 'fired';
        if (t.program) {
          stage = 'program';
          event = this.admitProgram(t, t.program, delivery);
        } else if (t.targetKind === 'operation') this.effects.operation(t.target!, t, delivery);
        else {
          stage = 'instructions';
          const words = t.file ? this.effects.instructions?.(t.file) : t.instructions ?? '';
          if (words === undefined) throw new Error('No repository instructions reader');
          stage = 'inbox';
          // The delivery may find the trigger can no longer fire at all (tempo.ts): it is stopped here, with its firing.
          const did = this.effects.inbox(t, delivery, words);
          if (did === 'stop') { this.db.update(triggers).set({ enabled: false }).where(eq(triggers.id, t.id)).run(); this.log(t.id, 'stopped'); }
        }
        const rest = this.rest(t, spent), stopped = !this.get(t.id).enabled, standing = !stopped && rest.standing;
        this.db.update(triggers).set({ state: stopped ? 'stopped' : standing ? (this.paused(t) ? 'held' : 'standing') : 'fired', enabled: standing, nextDueAt: standing ? rest.nextDueAt : null, lastFiredAt: event === 'fired' ? this.now() : t.lastFiredAt, changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
        this.log(t.id, event, eventId);
      });
    } catch (error) {
      // One bad firing must not end a standing trigger: a lane that could not read its
      // instructions tonight still runs tomorrow. Only a once-only trigger ends as failed.
      this.db.transaction(() => {
        const rest = this.rest(t, spent);
        if (this.get(t.id).enabled && rest.standing) this.db.update(triggers).set({ state: this.paused(t) ? 'held' : 'standing', nextDueAt: rest.nextDueAt, changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
        else this.db.update(triggers).set({ state: 'failed', enabled: false, changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
        // The `failed` row keeps the event id, which is what stops a second try. The row after it says
        // which step failed and the error's first line: these are loom's own errors, not a body's words.
        this.log(t.id, 'failed', eventId);
        const why = (error instanceof Error ? error.message : String(error)).split(/[\r\n]/, 1)[0].slice(0, 200);
        this.log(t.id, 'failure', `${stage}: ${why}`);
      });
    }
  }
  close() { this.closed = true; this.cancel?.(); }
}

/** One more row of a trigger's log, written for it by the composition in the write that sets or changes the trigger:
 * what the engine itself does not know to say (src/shared-place-triggers.ts, a come-back that follows another). */
export function logTrigger(db: DataDatabase, at: string, trigger: string, event: string, note: string): void {
  const seq = (db.select({ seq: max(triggerLog.seq) }).from(triggerLog).get()?.seq ?? 0) + 1;
  db.insert(triggerLog).values({ seq, trigger, at, event, note }).run();
}

/** Every trigger filed under one project is filed under another: for a merge of the two (shared-projects.ts). */
export function refileTriggers(db: DataDatabase, from: string, into: string): void {
  db.update(triggers).set({ project: into }).where(eq(triggers.project, from)).run();
}

/** Record a validated worker result or a job that ended without one. A reported JSON null clears a
 * previous marker and is passed as null on the next firing. Omission leaves the previous marker alone. */
export function finishProgramFiring(db: DataDatabase, firing: typeof programFirings.$inferSelect, status: 'done' | 'failed', line: string | null, state?: HouseProgram['state']): void {
  const changed = db.update(programFirings).set({ status, line }).where(and(eq(programFirings.id, firing.id), eq(programFirings.status, 'pending'))).run();
  if (changed.changes && status === 'done' && state !== undefined)
    db.update(triggers).set({ programState: state === null ? sql`'null'` : state }).where(eq(triggers.id, firing.trigger)).run();
}
