/** Offline only: the composition root owns the stopped-daemon gate. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { migrate, type Db } from '../../core/index.js';
import { apply, emptyState, type StoreState, type Task, type Link } from './domain.js';
import { load, persist, type ScopedTask } from './store.js';
import { schema } from './schema/001.js';
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};
/** Checksum is of the SQLite read snapshot, including WAL-visible committed records. */
export function importTasks(db: Db, from: string, now: number, options: { interrupt?: () => void; afterSourceTasks?: () => void; projects?: Record<string, string> } = {}) {
  const source = new Database(from, { readonly: true, fileMustExist: true });
  let original: StoreState;
  try {
    original = source.transaction(() => {
      const tasks = (source.prepare('SELECT record FROM tasks ORDER BY ord').all() as { record: string }[]).map(r => JSON.parse(r.record) as Task);
      options.afterSourceTasks?.();
      const links = (source.prepare('SELECT record FROM links ORDER BY ord').all() as { record: string }[]).map(r => JSON.parse(r.record) as Link);
      const seq = source.prepare("SELECT value FROM meta WHERE key='seq'").get() as { value: string } | undefined;
      return { tasks, links, seq: Number(seq?.value ?? 0) };
    })();
  } finally { source.close(); }
  if (!Number.isSafeInteger(original.seq) || original.seq < 0) throw new Error('Invalid source sequence');
  const projectMap = options.projects ?? {};
  if (Object.values(projectMap).some(p => typeof p !== 'string' || !p)) throw new Error('Invalid epic project map');
  const mapping = canonical(projectMap);
  const checksum = createHash('sha256').update(canonical(original)).digest('hex');
  return db.transaction(() => {
    migrate(db, 'tasks', schema);
    const old = db.prepare("SELECT value FROM tasks_meta WHERE key='source-checksum'").get() as { value: string } | undefined;
    if (old) {
      if (old.value !== checksum || (db.prepare("SELECT value FROM tasks_meta WHERE key='source-projects'").get() as { value: string } | undefined)?.value !== mapping) throw new Error('A different tasks source was already imported');
      return { ok: true, imported: false, checksum, tasks: original.tasks.length, links: original.links.length };
    }
    if (load(db).tasks.length || load(db).links.length) throw new Error('Tasks destination must be empty before import');
    const checked = apply(emptyState(), { op: 'import', tasks: original.tasks, links: original.links, actor: 'migration', at: new Date(now).toISOString() });
    if (!checked.result.ok) throw new Error(`Invalid source: ${JSON.stringify(checked.result)}`);
    if (checked.state.seq > original.seq) throw new Error('Source sequence would reuse a generated id');
    // Preserve the original records exactly; validation must not quietly drop fields.
    const expected: StoreState = structuredClone(original);
    const byId = new Map(expected.tasks.map(t => [t.id, t as ScopedTask]));
    for (const task of expected.tasks as ScopedTask[]) {
      delete task.project;
      let ancestor = task;
      const seen = new Set<string>();
      for (;;) {
        if (seen.has(ancestor.id)) throw new Error('Parent cycle in source');
        seen.add(ancestor.id);
        if (ancestor.type === 'epic') {
          const raw = original.tasks.find(t => t.id === ancestor.id) as ScopedTask;
          if (Object.hasOwn(projectMap, ancestor.id) && raw.project !== undefined && raw.project !== projectMap[ancestor.id]) throw new Error('Epic project map conflicts with source project');
          const project = raw.project ?? (Object.hasOwn(projectMap, ancestor.id) ? projectMap[ancestor.id] : undefined);
          if (typeof project === 'string' && project) { task.project = project; break; }
        }
        const parent = expected.links.find(l => l.type === 'parent-child' && l.id === ancestor.id);
        if (!parent) break;
        const next = byId.get(parent.dependsOn); if (!next) throw new Error('Unknown source parent'); ancestor = next;
      }
    }
    persist(db, expected, now);
    options.interrupt?.();
    const actual = load(db);
    if (canonical(actual) !== canonical(expected)) throw new Error('Tasks import comparison failed: ids, counts or content differ');
    db.prepare("INSERT INTO tasks_meta VALUES ('source-checksum',?)").run(checksum);
    db.prepare("INSERT INTO tasks_meta VALUES ('source-projects',?)").run(mapping);
    return { ok: true, imported: true, checksum, tasks: expected.tasks.length, links: expected.links.length };
  })();
}
