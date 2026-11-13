import type { Db } from '../../core/index.js';
import { emptyState, type StoreState, type Task, type Link } from './domain.js';
export type ScopedTask = Task & { project?: string; agent?: string };
export function load(db: Db): StoreState {
  const state = emptyState();
  state.tasks = (db.prepare('SELECT record FROM tasks_tasks ORDER BY ord').all() as { record: string }[]).map(r => JSON.parse(r.record) as Task);
  state.links = (db.prepare('SELECT record FROM tasks_links ORDER BY ord').all() as { record: string }[]).map(r => JSON.parse(r.record) as Link);
  const seq = db.prepare("SELECT value FROM tasks_meta WHERE key='seq'").get() as { value: string } | undefined;
  state.seq = Number(seq?.value ?? 0);
  return state;
}
/** Called only inside the registry/importer's transaction. Preserve unchanged timestamps. */
export function persist(db: Db, state: StoreState, now: number): string[] {
  const old = new Map((db.prepare('SELECT id, record, ord FROM tasks_tasks').all() as { id: string; record: string; ord: number }[]).map(r => [r.id, r]));
  const changed = new Set<string>(), moved = new Set<string>();
  const held = new Set(state.tasks.map(t => t.id));
  for (const id of old.keys()) if (!held.has(id)) { db.prepare('DELETE FROM tasks_tasks WHERE id=?').run(id); changed.add(id); }
  const put = db.prepare('INSERT INTO tasks_tasks(ord,id,record,changed_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET ord=excluded.ord, record=excluded.record, changed_at=excluded.changed_at');
  state.tasks.forEach((task, ord) => {
    const json = JSON.stringify(task);
    if (old.get(task.id)?.record !== json) {
      const previous = old.get(task.id);
      if (previous) {
        const was = JSON.parse(previous.record) as ScopedTask, next = task as ScopedTask;
        if (was.project !== next.project || was.agent !== next.agent) moved.add(task.id);
      }
      put.run(ord, task.id, json, now); changed.add(task.id);
    }
    else if (old.get(task.id)?.ord !== ord) db.prepare('UPDATE tasks_tasks SET ord=? WHERE id=?').run(ord, task.id);
  });
  const links = (db.prepare('SELECT record FROM tasks_links ORDER BY ord').all() as { record: string }[]).map(r => JSON.parse(r.record) as Link);
  if (JSON.stringify(links) !== JSON.stringify(state.links)) {
    for (const l of [...links, ...state.links]) { changed.add(l.id); changed.add(l.dependsOn); }
    db.exec('DELETE FROM tasks_links');
    const insert = db.prepare('INSERT INTO tasks_links VALUES (?,?)');
    state.links.forEach((l, ord) => insert.run(ord, JSON.stringify(l)));
    for (const id of changed) db.prepare('UPDATE tasks_tasks SET changed_at=? WHERE id=?').run(now, id);
  }
  // A referenced task moving scope changes the viewer's projected relation fields.
  for (const link of state.links) if (moved.has(link.dependsOn)) changed.add(link.id);
  db.prepare("INSERT INTO tasks_meta VALUES ('seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(state.seq));
  return [...changed];
}
