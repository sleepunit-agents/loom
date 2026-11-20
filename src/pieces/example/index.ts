import { registerBuiltinService } from '../../core/services.js';
/** Test-only piece. Production startup never installs it. */
import { z } from 'zod';
import { migrate, operation, maySee, mayCreate, mayMove, mayAct, OperationError, type Db, type Operations, type Live, type Sharing, type RecordScope, type LiveRecord } from '../../core/index.js';
import { schema } from './schema/001.js';
interface Row extends RecordScope, LiveRecord { id: string; title: string; parent: string | null; expires: number | null }
export function installExample(db: Db, operations: Operations, live: Live, sharing: () => Sharing) {
  registerBuiltinService(operations, 'example', ['example.record']);
  migrate(db, 'example', schema);
  const row = (id: string) => db.prepare('SELECT * FROM example_records WHERE id = ?').get(id) as Row | undefined;
  // SQLite NULL is absence in the policy model.
  const read = (id: string): Row | undefined => {
    const r = row(id); if (!r) return;
    return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as Row;
  };
  const input = z.object({ id: z.string().min(1), title: z.string(), project: z.string().optional(), agent: z.string().optional(), member: z.string().optional(), parent: z.string().optional(), expires: z.number().optional() });
  operations.register(operation({ name: 'example.put', write: true, input, output: input,
    may: (v, i) => { const old = read(i.id); return old ? mayMove(v, old, i, sharing()) : mayCreate(v, i, sharing()); },
    run: (ctx, i) => {
      ctx.db.prepare('INSERT INTO example_records VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, project=excluded.project, agent=excluded.agent, member=excluded.member, parent=excluded.parent, expires=excluded.expires').run(i.id, i.title, i.project ?? null, i.agent ?? null, i.member ?? null, i.parent ?? null, i.expires ?? null);
      ctx.changed('example.record', i.id); return read(i.id);
    },
  }));
  operations.register(operation({ name: 'example.remove', write: true, output: z.object({ id: z.string() }), input: z.object({ id: z.string() }),
    may: (v, i) => { const r = read(i.id); return !!r && mayAct(v, r, sharing()); },
    run: (ctx, i) => { if (!row(i.id)) throw new OperationError('not-found', 'No record'); ctx.db.prepare('DELETE FROM example_records WHERE id=?').run(i.id); ctx.changed('example.record', i.id); return { id: i.id }; },
  }));
  live.register({ name: 'example.record',
    read(id, viewer) { const r = read(id); return r && maySee(viewer, r, sharing()) ? r : undefined; },
    ids: () => (db.prepare('SELECT id FROM example_records').all() as { id: string }[]).map(r => r.id),
    inScope: (r, parent, now) => (parent === undefined || r.parent === parent) && (typeof r.expires !== 'number' || r.expires > now),
    expires: r => typeof r.expires === 'number' ? r.expires : undefined,
  });
}
