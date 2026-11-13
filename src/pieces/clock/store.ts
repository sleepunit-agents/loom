import { registerExportFilter, privateExportCopy, type Db, type Scope, type Viewer, type Context } from '../../core/index.js';
export type WakeState = 'pending' | 'parked' | 'firing' | 'held' | 'fired' | 'cancelled' | 'failed';
export interface Work extends Scope {
  agent: string; prompt?: string; file?: string; note: string; model?: string;
  continuation?: string; slot?: string; approval?: string; place?: string;
  /** Identifies lane work superseded while a runtime start was in flight. */
  laneVersion?: string;
  /** Ordinary recurring work must not retry a revision that was replaced or removed. */
  scheduleRevision?: string;
}
export interface Wake extends Work {
  id: string; due: number; state: WakeState; createdAt: number; changedAt: number;
  by: Viewer; schedule?: string; attempt?: string; outcome?: string; hold?: string;
  failures: number; bypassPause?: boolean;
  /** Explicit lane run-now keeps its schedule link but consumes one-off capacity. */
  runNow?: boolean;
  /** Fixed-word safety wake from explicit composition configuration, never caller input. */
  deadman?: true;
  wait?: { id: string; until: number; kind?: string; target?: string; answer?: string };
  /** Imported provenance is data, never a Viewer or a grant. */
  legacy?: Record<string, unknown>;
  /** Fresh owner adoption; archived provenance remains inert and unchanged. */
  vouched?: { by: string; at: number };
}
export interface Schedule extends Work {
  id: string; at: string[]; days: string; by: Viewer; changedAt: number;
  lane?: string; enabled: boolean;
  laneDetails?: { text: string; source?: string; local: boolean };
}
export function wakes(db: Db): Wake[] { return (db.prepare('SELECT record FROM clock_wakes ORDER BY id').all() as { record: string }[]).map(r => JSON.parse(r.record)); }
export function schedules(db: Db): Schedule[] { return (db.prepare('SELECT record FROM clock_schedules ORDER BY id').all() as { record: string }[]).map(r => JSON.parse(r.record)); }
export function wake(db: Db, id: string): Wake | undefined { const r = db.prepare('SELECT record FROM clock_wakes WHERE id=?').get(id) as { record: string } | undefined; return r && JSON.parse(r.record); }
export function schedule(db: Db, id: string): Schedule | undefined { const r = db.prepare('SELECT record FROM clock_schedules WHERE id=?').get(id) as { record: string } | undefined; return r && JSON.parse(r.record); }
export function saveWake(ctx: Context, w: Wake) {
  w.changedAt = ctx.now;
  if(w.member)ctx.db.prepare("INSERT OR IGNORE INTO clock_meta(key,value) VALUES (?,?)").run("private-id:"+w.id,JSON.stringify({member:w.member}));
  ctx.db.prepare('INSERT INTO clock_wakes VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record, changed_at=excluded.changed_at').run(w.id, JSON.stringify(w), ctx.now);
  ctx.changed('wake', w.id);
}
export function saveSchedule(ctx: Context, s: Schedule) {
  s.changedAt = ctx.now;
  ctx.db.prepare('INSERT INTO clock_schedules VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record, changed_at=excluded.changed_at').run(s.id, JSON.stringify(s), ctx.now);
  ctx.changed('schedule', s.id);
}
export function event(ctx: Context, w: Wake, kind: string) {
  ctx.db.prepare('INSERT INTO clock_events(wake,record) VALUES (?,?)').run(w.id, JSON.stringify({ at: ctx.now, kind, outcome: w.outcome, note: w.note, agent: w.agent, ...(w.member?{member:w.member}:{}) }));
}
export const paused = (db: Db, agent: string) => !!db.prepare('SELECT 1 FROM clock_pauses WHERE agent=?').get(agent);
export const active = (w: Wake) => ['pending', 'parked', 'firing', 'held'].includes(w.state);

export function installPrivateExport(db:Db) {
 registerExportFilter(db,'clock',(table,row)=>{
  if(!table.startsWith('clock_') && table!=='core_operations')return true;
  if(table==='clock_meta' && String(row.key).startsWith('local-standing-receipt:')) {
   const saved=JSON.parse(String(row.value));
   if(['clock.command','clock.requestLocal','clock.recoverLocal','clock.scheduleLocalFromWindow'].includes(saved.name))return false;
  }
  const ids=new Set((db.prepare("SELECT key FROM clock_meta WHERE key LIKE 'private-id:%'").all() as {key:string}[]).map(r=>r.key.slice(11)));
  for(const w of [...wakes(db),...schedules(db)])if(w.member)ids.add(w.id);
  return !(table==='core_operations' && ['clock.command','clock.requestLocal','clock.recoverLocal','clock.scheduleLocalFromWindow'].includes(String(row.name))) && !privateExportCopy(row,ids);
 });
}
