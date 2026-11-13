import { operation } from './commands.js';
/** Metadata retention and checked findings. No legacy store or message text is read. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { failure, maySee, mayAct, mayCreate, type Db, type Operations, type Live, type Sharing, type Scope, type LiveRecord, type Viewer, type Clock, type Result } from '../../core/index.js';
import type { Conversation, Turn } from './conversations.js';
const DAY_MS = 86_400_000;
export const RETENTION_DAYS = 90;
const key = z.string().regex(/^cv-[a-f0-9]{12}$/);
const date = z.string().datetime().transform(s => new Date(s).toISOString());
const printable = (max: number) => z.string().min(1).max(max).regex(/^[^\x00-\x1f\x7f]+$/).refine(s => !!s.trim());
export interface Day extends Scope {
  id: string; conversation: string; day: string; counts: Record<string, number>;
  median_latency_ms: number | null; outcomes: Record<string, Record<string, number>>;
}
export interface Finding extends Scope {
  id: string; conversation: string; seq: number; day: string; measure: string;
  score: number | null; text: string; at: string;
}
export const findingId = (conversation: string, day: string) => `fd-${createHash('sha256').update(`${conversation}\0${day}`).digest('hex').slice(0, 12)}`;
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Held-turn measure, as in the old scorecard pass; folded days cannot reconstruct runs. */
export function dueToProgressSeconds(turns: readonly Pick<Turn, 'seq' | 'at' | 'kind' | 'run' | 'outcome'>[]): number | null {
  const ordered = [...turns].sort((a, b) => a.seq - b.seq);
  const runs = new Map<string, typeof ordered>();
  for (const t of ordered) if (t.run && ['reply', 'action', 'note'].includes(t.kind)) { const r = runs.get(t.run) ?? []; r.push(t); runs.set(t.run, r); }
  const spans: number[] = [];
  for (const rs of runs.values()) {
    const first = rs[0], wake = ordered.filter(t => t.kind === 'wake' && t.seq < first.seq).pop();
    const done = rs.find(t => t.outcome === 'progressed' || t.outcome === 'answered');
    if (wake && done) spans.push((Date.parse(done.at) - Date.parse(wake.at)) / 1000);
  }
  return median(spans);
}
const scopeOf = (c: Conversation): Scope => ({ agent: c.agent, ...(c.project ? { project: c.project } : {}), ...(c.member ? { member: c.member } : {}) });
export function installRetention(db: Db, operations: Operations, live: Live, sharing: () => Sharing) {
  const read = <T>(table: string, id: string): T | undefined => {
    const r = db.prepare(`SELECT record FROM ${table} WHERE id=?`).get(id) as { record: string } | undefined;
    return r && JSON.parse(r.record) as T;
  };
  const conversation = (id: string) => read<Conversation>('attention_conversations', id);
  const rows = <T>(table: string, id: string): T[] => (db.prepare(`SELECT record FROM ${table} WHERE conversation=?`).all(id) as { record: string }[]).map(r => JSON.parse(r.record) as T);
  const canRead = (v: Viewer, id: string, type: string) => { const c = conversation(id); return !!c && maySee(v, { type, ...scopeOf(c) }, sharing()); };
  operations.register(operation({ name: 'attention.fold', write: true, input: z.object({ conversation: key }).strict(), output: z.unknown(),
    may(v, i) { const c = conversation(i.conversation); return !!c && mayAct(v, { type: 'attention.day', ...scopeOf(c) }, sharing(), 'act', 'attention.fold'); },
    run(ctx, i) {
      const c = conversation(i.conversation)!, groups = new Map<string, Turn[]>();
      for (const t of rows<Turn>('attention_turns', c.id)) { const day = t.at.slice(0, 10), ts = groups.get(day) ?? []; ts.push(t); groups.set(day, ts); }
      const cutoff = new Date(ctx.now - RETENTION_DAYS * DAY_MS).toISOString();
      let days = 0, turns = 0;
      for (const [day, ts] of groups) {
        if (ts.some(t => t.at >= cutoff) || db.prepare('SELECT 1 FROM attention_days WHERE conversation=? AND day=?').get(c.id, day)) continue;
        const counts: Record<string, number> = {}, outcomes: Record<string, Record<string, number>> = Object.create(null);
        for (const t of ts) {
          counts[t.kind] = (counts[t.kind] ?? 0) + 1;
          if (t.outcome) { const m = (outcomes[t.model ?? 'unknown'] ??= Object.create(null)); m[t.outcome] = (m[t.outcome] ?? 0) + 1; }
        }
        const mid = median(ts.filter(t => t.kind === 'reply' && t.latency_ms !== undefined).map(t => t.latency_ms!));
        const record: Day = { ...scopeOf(c), id: `${c.id}:${day}`, conversation: c.id, day, counts, median_latency_ms: mid === null ? null : Math.round(mid), outcomes };
        db.prepare('INSERT INTO attention_days VALUES (?,?,?,?)').run(record.id, c.id, day, JSON.stringify(record));
        for (const t of ts) { db.prepare('DELETE FROM attention_turns WHERE id=?').run(t.id); ctx.changed('attention.turn', t.id); }
        ctx.changed('attention.day', record.id); days++; turns += ts.length;
      }
      return { days, turns };
    },
  }));
  operations.register(operation({ name: 'attention.retain', write: true, input: z.object({}).strict(), output: z.unknown(),
    may: v => v.kind !== 'service' || mayAct(v, { type: 'attention.day' }, sharing(), 'act', 'attention.retain'),
    run(ctx) {
      let days = 0, turns = 0;
      for (const row of db.prepare('SELECT record FROM attention_conversations ORDER BY id').all() as { record: string }[]) {
        const c = JSON.parse(row.record) as Conversation;
        if (!mayAct(ctx.viewer, { type: 'attention.day', ...scopeOf(c) }, sharing(), 'act', 'attention.fold')) continue;
        const result = operations.call('direct', ctx.viewer, 'attention.fold', { conversation: c.id }, `retention:${randomUUID()}`);
        if (!result.ok) return result;
        const count = result.value as { days: number; turns: number }; days += count.days; turns += count.turns;
      }
      return { days, turns };
    },
  }));
  operations.register(operation({ name: 'attention.days', input: z.object({ conversation: key }).strict(), output: z.unknown(),
    may: (v, i) => canRead(v, i.conversation, 'attention.day'),
    run: (_ctx, i) => rows<Day>('attention_days', i.conversation).sort((a, b) => a.day.localeCompare(b.day)),
  }));
  operations.register(operation({ name: 'attention.stats', input: z.object({ conversation: key }).strict(), output: z.unknown(),
    // Both sources must be visible, including for services with type grants.
    may: (v, i) => canRead(v, i.conversation, 'attention.turn') && canRead(v, i.conversation, 'attention.day'),
    run(_ctx, i) {
      const counts: Record<string, number> = {}, outcomes: Record<string, number> = {};
      const add = (to: Record<string, number>, key: string, n: number) => { to[key] = (to[key] ?? 0) + n; };
      for (const t of rows<Turn>('attention_turns', i.conversation)) { add(counts, t.kind, 1); if (t.outcome) add(outcomes, t.outcome, 1); }
      for (const d of rows<Day>('attention_days', i.conversation)) {
        for (const [k, n] of Object.entries(d.counts)) add(counts, k, n);
        for (const byOutcome of Object.values(d.outcomes)) for (const [o, n] of Object.entries(byOutcome)) add(outcomes, o, n);
      }
      return { counts, outcomes };
    },
  }));
  operations.register(operation({ name: 'attention.writeFinding', write: true,
    input: z.object({ conversation: key, seq: z.number().int().min(1), measure: printable(120), score: z.number().min(1).max(5).nullable(), text: printable(200) }).strict(), output: z.unknown(),
    may(v, i) { const c = conversation(i.conversation); return !!c && mayCreate(v, { type: 'attention.finding', ...scopeOf(c) }, sharing(), 'attention.writeFinding'); },
    run(ctx, i) {
      const t = rows<Turn>('attention_turns', i.conversation).find(t => t.seq === i.seq);
      if (!t) return failure('not-found', 'No such held turn');
      // The old review route only accepted the agent's own turns.
      if (!['reply', 'action', 'note'].includes(t.kind)) return failure('conflict', "A finding is on the agent's own turn");
      const day = t.at.slice(0, 10);
      if (db.prepare('SELECT 1 FROM attention_findings WHERE conversation=? AND day=?').get(i.conversation, day)) return failure('conflict', 'One finding per conversation per UTC day');
      const record: Finding = { ...scopeOf(conversation(i.conversation)!), ...i, text: i.text.trim(), id: findingId(i.conversation, day), day, at: new Date(ctx.now).toISOString() };
      db.prepare('INSERT INTO attention_findings VALUES (?,?,?,?)').run(record.id, i.conversation, day, JSON.stringify(record));
      ctx.changed('attention.finding', record.id); return record;
    },
  }));
  operations.register(operation({ name: 'attention.findings', input: z.object({ conversation: key.optional(), agent: z.string().optional(), since: date.optional(), limit: z.number().int().min(1).max(500).default(500) }).strict(), output: z.unknown(),
    may: v => v.kind !== 'service' || mayAct(v, { type: 'attention.finding' }, sharing(), 'act', 'attention.findings'),
    run(ctx, i) {
      return (db.prepare('SELECT record FROM attention_findings').all() as { record: string }[]).map(r => JSON.parse(r.record) as Finding)
        .filter(f => maySee(ctx.viewer, { type: 'attention.finding', ...f }, sharing()) && (!i.conversation || f.conversation === i.conversation) && (!i.agent || f.agent === i.agent) && (!i.since || f.at > i.since))
        .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, i.limit);
    },
  }));
  for (const [name, table] of [['attention.day', 'attention_days'], ['attention.finding', 'attention_findings']] as const) live.register({
    name, ids: () => (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map(r => r.id),
    read(id, viewer) { const r = read<Day | Finding>(table, id); return r && maySee(viewer, { type: name, ...r }, sharing()) ? r as unknown as LiveRecord : undefined; },
    inScope: (r, parent) => parent === undefined || r.conversation === parent,
  });
}
/** Explicit daemon composition hook. No files, polling process or host timer. Stop before closing the foundation. */
export function startAttentionRetention(operations: Operations, viewer: Viewer, report: (result: Result) => void): () => void {
  const clock: Clock = operations.clock;
  let stopped = false, cancel: (() => void) | undefined;
  const sweep = () => {
    if (stopped) return;
    report(operations.call('direct', viewer, 'attention.retain', {}, `attention-retain:${randomUUID()}`));
    if (!stopped) cancel = clock.at(clock.now() + DAY_MS, sweep);
  };
  cancel = clock.at(clock.now(), sweep);
  return () => { stopped = true; cancel?.(); };
}
