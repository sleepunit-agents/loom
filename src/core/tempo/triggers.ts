import { randomUUID } from 'node:crypto';
import { and, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../data/database.js';
import { agentPauses, household, triggerEdits, triggerLog, triggers } from '../data/schema.js';
import type { Clock } from '../clock.js';
import { localDate, nextTime } from './calendar.js';

export type Trigger = typeof triggers.$inferSelect;
const text = z.string().min(1);
export const triggerInput = z.object({
  id: text.optional(), ownerKind: z.enum(['member', 'agent', 'household']), owner: text.nullable().optional(),
  sourceKind: z.enum(['time', 'pull-request', 'answer', 'job']), watches: text.nullable().optional(),
  times: text.nullable().optional(), days: text.nullable().optional(), lifespan: z.enum(['until-stopped', 'today', 'once']),
  targetKind: z.enum(['operation', 'inbox']), target: text.nullable().optional(),
  toKind: z.enum(['person', 'agent']).nullable().optional(), to: text.nullable().optional(), project: text.nullable().optional(),
  instructions: z.string().max(100_000).nullable().optional(), file: text.nullable().optional(), note: text,
  /** The kind of model the work should run on: a tag such as best, normal or low, or one model by name. */
  wantsModel: text.max(200).nullable().optional(),
});
export type NewTrigger = z.input<typeof triggerInput>;
/** The parts of a standing trigger that can change after it is set. Who it is for, what it
 * watches and what it does cannot: stop it and set another. */
export const triggerEdit = z.object({
  instructions: z.string().max(100_000).nullable().optional(), file: text.nullable().optional(),
  times: text.optional(), days: text.nullable().optional(), note: text.optional(), wantsModel: text.max(200).nullable().optional(),
}).strict();
export type TriggerEdit = z.input<typeof triggerEdit>;
const relativeFile = (file: string) => !/^(?:\/|[A-Za-z]:)/.test(file) && !file.split(/[\\/]/).includes('..');
export interface TriggerEffects {
  /** Synchronous shared-database writes only; both callbacks run in the trigger's
   * transaction. The delivery id is the inbox source_id. Never start a body. */
  inbox(trigger: Trigger, deliveryId: string, words: string): void;
  operation(name: string, trigger: Trigger, deliveryId: string): void;
  /** Whether an operation target names something this program can run. Checked when a trigger is set. */
  knows?(name: string): boolean;
  /** Resolve relative household repository files; no runtime home is read here. */
  instructions?(file: string): string;
  changed?(): void;
}

/** How late a time trigger may still fire. See "Missed times" on TriggerEngine. */
export const MISSED_GRACE_MS = 5 * 60_000;

/** Source adapters report PR changes, answered approvals/questions/secrets and
 * stopped jobs here. Time deadlines are driven by the injected clock.
 *
 * Missed times. A time trigger fires at its time, or up to MISSED_GRACE_MS after it. A time that could
 * not fire within that (its agent was paused, the program was not running, the clock jumped) is skipped,
 * not fired late: the log says `missed`, and the next time is worked out from now. So a 09:00 lane never
 * runs at 14:00 because the server came back then, and nothing fires twice to catch up. A once-only
 * trigger whose time is skipped ends as stopped. The same rule covers the other two ways a time passes
 * unfired: a trigger that is off has no times, so turning it on (or changing its times) starts from now;
 * and a firing that fails has used its time, is logged `failed` with the stage, and is not tried again.
 * Events (an answer, a job, a pull request) are not times: one seen while held fires on resume. */
export class TriggerEngine {
  private cancel?: () => void;
  private closed = false;
  private ticking = false;
  private again = false;
  constructor(private db: DataDatabase, private clock: Clock, private effects: TriggerEffects) {}
  private open() { if (this.closed) throw new Error('Tempo is closed'); }
  private now() { return new Date(this.clock.now()).toISOString(); }
  private zone() { return this.db.select({ zone: household.timezone }).from(household).get()?.zone ?? 'UTC'; }
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
  set(value: NewTrigger): Trigger {
    this.open();
    const v = triggerInput.parse(value);
    if ((v.ownerKind === 'household') !== !v.owner) throw new Error('Trigger needs its owner');
    if (!!v.toKind !== !!v.to) throw new Error('A recipient needs both kind and id');
    if (v.targetKind === 'inbox' && (!v.toKind || !v.to)) throw new Error('Inbox target needs a recipient');
    if (v.targetKind === 'operation' && !v.target) throw new Error('Operation target needs a name');
    if (v.targetKind === 'operation' && this.effects.knows && !this.effects.knows(v.target!)) throw new Error('Unknown operation');
    if (v.sourceKind !== 'time' && !v.watches) throw new Error('Event trigger needs what it watches');
    if (v.file && !relativeFile(v.file)) throw new Error('Instructions must be a relative repository file');
    if (v.file && v.instructions) throw new Error('Give instructions or a file');
    const due = this.due(v.sourceKind, v.times, v.days, v.lifespan);
    const id = v.id ?? `tr-${randomUUID()}`;
    this.db.transaction(() => {
      this.db.insert(triggers).values({ ...v, id, enabled: true, state: 'standing', nextDueAt: due, createdAt: this.now(), changedAt: this.now() }).run();
      if (this.paused(this.get(id))) this.db.update(triggers).set({ state: 'held' }).where(eq(triggers.id, id)).run();
      this.log(id, 'set');
    });
    this.tick(); return this.get(id);
  }
  stop(id: string): void {
    this.open();
    this.db.transaction(() => { this.get(id); this.db.update(triggers).set({ enabled: false, state: 'stopped', nextDueAt: null, changedAt: this.now() }).where(eq(triggers.id, id)).run(); this.log(id, 'stopped'); });
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
  /** Change a trigger's words, times, label or wanted model, keeping what the changed parts said before and who changed them. */
  edit(id: string, change: TriggerEdit, by: { kind: 'member' | 'agent'; id: string }): void {
    this.open();
    const c = triggerEdit.parse(change);
    this.db.transaction(() => {
      const t = this.get(id);
      // Giving the words drops the file and giving a file drops the words: a trigger reads from one place.
      if (c.instructions != null && c.file === undefined) c.file = null;
      if (c.file != null && c.instructions === undefined) c.instructions = null;
      if (c.file && c.instructions) throw new Error('Give instructions or a file');
      if (c.file && !relativeFile(c.file)) throw new Error('Instructions must be a relative repository file');
      if ((c.times !== undefined || c.days !== undefined) && t.sourceKind !== 'time') throw new Error('Only a time trigger has times');
      const before: Record<string, string | null> = {};
      for (const key of ['instructions', 'file', 'times', 'days', 'note', 'wantsModel'] as const) if (c[key] !== undefined && c[key] !== t[key]) before[key] = t[key];
      if (!Object.keys(before).length) return;
      const next = { ...t, ...c };
      const due = t.enabled && ('times' in before || 'days' in before) ? this.due(t.sourceKind, next.times, next.days, t.lifespan) : t.nextDueAt;
      this.db.update(triggers).set({ instructions: next.instructions, file: next.file, times: next.times, days: next.days, note: next.note, wantsModel: next.wantsModel, nextDueAt: due, changedAt: this.now() }).where(eq(triggers.id, id)).run();
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
  private scan(): void {
    this.cancel?.(); this.cancel = undefined;
    let next: number | undefined;
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
        if (late >= 0 && late <= MISSED_GRACE_MS) this.fire(t, `time:${t.nextDueAt}`);
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
      if (current.enabled && current.nextDueAt && current.state !== 'failed') next = Math.min(next ?? Infinity, Date.parse(current.nextDueAt));
    }
    if (!this.closed && next !== undefined) this.cancel = this.clock.at(next, () => this.tick());
  }
  private stopExpired(t: Trigger) {
    this.db.transaction(() => { this.db.update(triggers).set({ enabled: false, state: 'stopped', nextDueAt: null, changedAt: this.now() }).where(eq(triggers.id, t.id)).run(); this.log(t.id, 'stopped', 'today ended'); });
  }
  /** Where a trigger stands once the time or event it was due for is spent: whether it goes on, and when next. */
  private rest(t: Trigger): { standing: boolean; nextDueAt: string | null } {
    if (t.lifespan === 'once') return { standing: false, nextDueAt: null };
    if (t.sourceKind !== 'time') return { standing: true, nextDueAt: null };
    const next = nextTime(t.times!, t.days, this.clock.now(), this.zone());
    const standing = Number.isFinite(next) && (t.lifespan !== 'today' || localDate(next, this.zone()) === localDate(this.clock.now(), this.zone()));
    return { standing, nextDueAt: standing ? new Date(next).toISOString() : null };
  }
  /** Skip a time that is more than the grace behind: nothing is delivered, and the trigger moves to its next time. */
  private miss(t: Trigger) {
    this.db.transaction(() => {
      const { standing, nextDueAt } = this.rest(t);
      this.db.update(triggers).set({ state: standing ? 'standing' : 'stopped', enabled: standing, nextDueAt, changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
      this.log(t.id, 'missed', `time:${t.nextDueAt}`);
    });
  }
  private fire(t: Trigger, eventId: string) {
    // What the firing was doing, for the log if it fails.
    let stage: 'operation' | 'instructions' | 'inbox' = 'operation';
    try {
      this.db.transaction(() => {
        this.db.update(triggers).set({ state: 'firing', changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
        const delivery = `${t.id}:${eventId}`;
        if (t.targetKind === 'operation') this.effects.operation(t.target!, t, delivery);
        else {
          stage = 'instructions';
          const words = t.file ? this.effects.instructions?.(t.file) : t.instructions ?? '';
          if (words === undefined) throw new Error('No repository instructions reader');
          stage = 'inbox';
          this.effects.inbox(t, delivery, words);
        }
        const rest = this.rest(t), stopped = !this.get(t.id).enabled, standing = !stopped && rest.standing;
        this.db.update(triggers).set({ state: stopped ? 'stopped' : standing ? (this.paused(t) ? 'held' : 'standing') : 'fired', enabled: standing, nextDueAt: standing ? rest.nextDueAt : null, lastFiredAt: this.now(), changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
        this.log(t.id, 'fired', eventId);
      });
    } catch (error) {
      // One bad firing must not end a standing trigger: a lane that could not read its
      // instructions tonight still runs tomorrow. Only a once-only trigger ends as failed.
      this.db.transaction(() => {
        const rest = this.rest(t);
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
