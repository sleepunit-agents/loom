import { randomUUID } from 'node:crypto';
import { and, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../data/database.js';
import { agentPauses, household, triggerLog, triggers } from '../data/schema.js';
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
  instructions: z.string().nullable().optional(), file: text.nullable().optional(), note: text,
});
export type NewTrigger = z.input<typeof triggerInput>;
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

/** Source adapters report PR changes, answered approvals/questions/secrets and
 * stopped jobs here. Time deadlines are driven by the injected clock. */
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
    if (v.file && (/^(?:\/|[A-Za-z]:)/.test(v.file) || v.file.split(/[\\/]/).includes('..'))) throw new Error('Instructions must be a relative repository file');
    if (v.file && v.instructions) throw new Error('Give instructions or a file');
    let due: string | null = null;
    if (v.sourceKind === 'time') {
      if (!v.times) throw new Error('Time trigger needs a time');
      const at = nextTime(v.times, v.days ?? null, this.clock.now() - 1, this.zone());
      if (!Number.isFinite(at)) throw new Error('Time is in the past');
      if (v.lifespan === 'today' && localDate(at, this.zone()) !== localDate(this.clock.now(), this.zone())) throw new Error('No time left today');
      due = new Date(at).toISOString();
    }
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
        if (t.nextDueAt && Date.parse(t.nextDueAt) <= this.clock.now()) this.fire(t, `time:${t.nextDueAt}`);
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
  private fire(t: Trigger, eventId: string) {
    try {
      this.db.transaction(() => {
        this.db.update(triggers).set({ state: 'firing', changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
        const delivery = `${t.id}:${eventId}`;
        if (t.targetKind === 'operation') this.effects.operation(t.target!, t, delivery);
        else {
          const words = t.file ? this.effects.instructions?.(t.file) : t.instructions ?? '';
          if (words === undefined) throw new Error('No repository instructions reader');
          this.effects.inbox(t, delivery, words);
        }
        const next = t.sourceKind === 'time' && t.lifespan !== 'once' ? nextTime(t.times!, t.days, this.clock.now(), this.zone()) : Infinity;
        const stopped = !this.get(t.id).enabled;
        const standing = !stopped && t.lifespan !== 'once' && (t.sourceKind !== 'time' || Number.isFinite(next)) &&
          (t.lifespan !== 'today' || t.sourceKind !== 'time' || localDate(next, this.zone()) === localDate(this.clock.now(), this.zone()));
        this.db.update(triggers).set({ state: stopped ? 'stopped' : standing ? (this.paused(t) ? 'held' : 'standing') : 'fired', enabled: standing, nextDueAt: standing && Number.isFinite(next) ? new Date(next).toISOString() : null, lastFiredAt: this.now(), changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
        this.log(t.id, 'fired', eventId);
      });
    } catch {
      // One bad firing must not end a standing trigger: a lane that could not read its
      // instructions tonight still runs tomorrow. Only a once-only trigger ends as failed.
      this.db.transaction(() => {
        const next = t.sourceKind === 'time' && t.lifespan !== 'once' ? nextTime(t.times!, t.days, this.clock.now(), this.zone()) : Infinity;
        const standing = this.get(t.id).enabled && t.lifespan !== 'once' && (t.sourceKind !== 'time' || Number.isFinite(next)) &&
          (t.lifespan !== 'today' || t.sourceKind !== 'time' || localDate(next, this.zone()) === localDate(this.clock.now(), this.zone()));
        if (standing) this.db.update(triggers).set({ state: this.paused(t) ? 'held' : 'standing', nextDueAt: Number.isFinite(next) ? new Date(next).toISOString() : null, changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
        else this.db.update(triggers).set({ state: 'failed', enabled: false, changedAt: this.now() }).where(eq(triggers.id, t.id)).run();
        this.log(t.id, 'failed', eventId);
      });
    }
  }
  close() { this.closed = true; this.cancel?.(); }
}
