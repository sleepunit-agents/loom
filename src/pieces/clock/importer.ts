/** Offline snapshot importer. Never reads programs, follows prompt paths, or starts jobs. */
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { migrate, type Db, type Viewer } from '../../core/index.js';
import { schema } from './schema/001.js';
import { daysOf, timesOf, parseAt } from './time.js';
import { wakes, schedules, type Work, type Wake, type Schedule } from './store.js';
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}` : JSON.stringify(v);
type Row = Record<string, unknown>;
function object(v: unknown): Row { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid legacy object'); return v as Row; }
function string(v: unknown, name: string): string { if (typeof v !== 'string' || !v.trim()) throw new Error(`Invalid legacy ${name}`); return v; }
function stamp(v: unknown): number { return parseAt(string(v, 'timestamp'), 0); }
const importedBy: Viewer = { kind: 'runner', id: 'clock-import:unverified' };
function work(r: Row, agent: string): Work {
  const prompt = r.prompt === undefined ? undefined : string(r.prompt, 'prompt');
  const file = r.prompt_file === undefined ? undefined : string(r.prompt_file, 'prompt file');
  if (!!prompt === !!file) throw new Error('Legacy work must have exactly one prompt or prompt_file');
  return { agent, note: typeof r.note === 'string' ? r.note : '', ...(prompt ? { prompt } : { file }), ...(typeof r.model === 'string' ? { model: r.model } : {}) };
}
/** --from is the old WAKE_DATA directory (agent subdirectories and lanes.json).
 * All imported work requires provenance review; old strings never become grants.
 * A stable byte snapshot is checked twice; the legacy writer must be stopped too.
 */
export function importClock(db: Db, from: string, now: number, options: { interrupt?: () => void } = {}) {
  const snapshot = () => {
    if (!lstatSync(from).isDirectory() || lstatSync(from).isSymbolicLink()) throw new Error('Clock source must be a directory');
    const files: Record<string, string> = {};
    const read = (relative: string) => {
      const path = join(from, relative);
      let stat; try { stat = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular source file: ${relative}`);
      files[relative] = readFileSync(path, 'utf8');
    };
    read('lanes.json');
    for (const agent of readdirSync(from).sort()) {
      const stat = lstatSync(join(from, agent));
      if (stat.isSymbolicLink()) throw new Error('Clock source contains a symbolic link');
      if (!stat.isDirectory()) continue;
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(agent)) throw new Error(`Invalid source agent: ${agent}`);
      for (const name of ['spool.jsonl', 'schedules.json', 'paused', 'wake.log', 'filed.json', 'sessions.json']) read(`${agent}/${name}`);
    }
    return files;
  };
  const files = snapshot(), expectedWakes: Wake[] = [], expectedSchedules: Schedule[] = [], pauses: { agent: string; since: number }[] = [];
  const agents = [...new Set(Object.keys(files).filter(p => p.includes('/')).map(p => p.split('/')[0]))].sort();
  if (!agents.length) throw new Error('No legacy agent clock files found');
  for (const agent of agents) {
    const scheduleId = (name: string) => `${agent}/${name}`;
    for (const line of (files[`${agent}/spool.jsonl`] ?? '').split('\n').filter(l => l.trim())) {
      const r = object(JSON.parse(line)), id = string(r.id, 'wake id');
      if (!/^w-[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid source wake id');
      const due = stamp(r.at), createdAt = stamp(r.created);
      const w: Wake = { ...(r.kind === 'watch' ? { agent, note: string(r.note, 'watch note') } : work(r, agent)), id, due, createdAt, changedAt: now, by: importedBy, failures: r.fails === undefined ? 0 : (() => { if (typeof r.fails !== 'number' || !Number.isSafeInteger(r.fails) || r.fails < 0) throw new Error('Invalid source failure count'); return r.fails; })(),
        state: 'held', hold: r._firing || r.kind === 'watch' ? 'uncertain' : 'provenance', outcome: r._firing ? 'Imported in-flight dispatch; reconcile with runtime before retrying' : 'Imported legacy authority requires owner review', legacy: r };
      if (r.schedule !== undefined) w.schedule = scheduleId(string(r.schedule, 'schedule reference'));
      if (r.kind === 'parked') w.wait = { id: string(r.on, 'park request'), until: stamp(r.until) };
      expectedWakes.push(w);
    }
    const sourceSchedules = object(JSON.parse(files[`${agent}/schedules.json`] ?? '{}'));
    for (const [id, raw] of Object.entries(sourceSchedules)) {
      const r = object(raw), at = timesOf(r.at as string | string[]), days = typeof r.days === 'string' ? r.days : ''; daysOf(days);
      expectedSchedules.push({ ...work(r, agent), id: scheduleId(id), at, days, by: importedBy, enabled: false, changedAt: now, ...(typeof r.lane === 'string' ? { lane: r.lane } : {}) });
    }
    if (files[`${agent}/paused`] !== undefined) pauses.push({ agent, since: stamp(object(JSON.parse(files[`${agent}/paused`])).since) });
  }
  if (new Set(expectedWakes.map(w => w.id)).size !== expectedWakes.length) throw new Error('Duplicate source wake ids');
  expectedWakes.sort((a,b) => a.id.localeCompare(b.id)); expectedSchedules.sort((a,b) => a.id.localeCompare(b.id));
  if (canonical(snapshot()) !== canonical(files)) throw new Error('Clock source changed during snapshot; stop its writer');
  const source = canonical(files), checksum = createHash('sha256').update(source).digest('hex');
  return db.transaction(() => {
    migrate(db, 'clock', schema);
    const old = db.prepare("SELECT value FROM clock_meta WHERE key='source-checksum'").get() as { value: string } | undefined;
    if (old) { if (old.value !== checksum) throw new Error('A different clock source was already imported'); return { ok: true, imported: false, checksum, wakes: expectedWakes.length, schedules: expectedSchedules.length }; }
    for (const table of ['clock_wakes','clock_schedules','clock_pauses','clock_events','clock_meta']) if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Error('Clock destination must be empty before import');
    for (const w of expectedWakes) db.prepare('INSERT INTO clock_wakes VALUES (?,?,?)').run(w.id, JSON.stringify(w), now);
    for (const s of expectedSchedules) db.prepare('INSERT INTO clock_schedules VALUES (?,?,?)').run(s.id, JSON.stringify(s), now);
    for (const p of pauses) db.prepare('INSERT INTO clock_pauses VALUES (?,?)').run(p.agent, p.since);
    // Exact source bytes retain logs, lanes, filed approvals and opaque runtime data.
    // They are archival data only, never dispatch credentials or executable inputs.
    db.prepare("INSERT INTO clock_meta VALUES ('legacy-snapshot',?)").run(source);
    options.interrupt?.();
    const actualPauses = db.prepare('SELECT agent,since FROM clock_pauses ORDER BY agent').all();
    if (canonical(wakes(db)) !== canonical(expectedWakes) || canonical(schedules(db)) !== canonical(expectedSchedules) || canonical(actualPauses) !== canonical(pauses)) throw new Error('Clock import comparison failed: ids, counts or content differ');
    db.prepare("INSERT INTO clock_meta VALUES ('source-checksum',?)").run(checksum);
    return { ok: true, imported: true, checksum, wakes: expectedWakes.length, schedules: expectedSchedules.length };
  })();
}
