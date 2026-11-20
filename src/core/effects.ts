/** One gate for all effects reaching outside a staging process. */
import { z } from 'zod';
import { migrate, type Db } from './db/index.js';
import { operation, OperationError } from './operations/index.js';
import { mayAct, maySee, type Sharing } from '../policy.js';
import type { Foundation } from './app.js';
export type EffectKind = 'wake' | 'bridge-send' | 'body-start' | 'push' | 'secret-write' | 'secret-read';
export interface Effect { id: string; kind: EffectKind; title: string; state: 'due' | 'released' | 'started' | 'done' | 'uncertain' }
const read = (db: Db, id: string) => db.prepare('SELECT * FROM core_effects WHERE id=?').get(id) as Effect | undefined;
export function installEffects(app: Foundation, sharing: () => Sharing, staging: boolean) {
  const released = new Set<(id: string) => void>();
  migrate(app.db, 'core', [{ number: 2, sql: `CREATE TABLE core_effects (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL)` }]);
  // An interrupted effect is never repeated automatically.
  app.db.prepare("UPDATE core_effects SET state='uncertain' WHERE state='started'").run();
  app.operations.register(operation({ name: 'core.releaseEffect', write: true, input: z.object({ id: z.string() }), output: z.unknown(),
    may: v => mayAct(v, { type: 'core.effect' }, sharing(), 'household'),
    run(ctx, { id }) {
      const r = read(ctx.db, id); if (!r) throw new OperationError('not-found', 'No held effect');
      if (r.state !== 'due') throw new OperationError('conflict', 'Effect is not held');
      ctx.db.prepare("UPDATE core_effects SET state='released' WHERE id=?").run(id); ctx.changed('core.effect', id);
      app.operations.clock.at(app.operations.clock.now(), () => { for (const listener of released) listener(id); });
      return read(ctx.db, id);
    },
  }));
  app.live.register({ name: 'core.effect', ids: () => (app.db.prepare('SELECT id FROM core_effects').all() as { id: string }[]).map(r => r.id),
    read: (id, v) => { const r = read(app.db, id); return r && maySee(v, { type: 'core.effect' }, sharing()) ? { ...r } : undefined; },
    inScope: r => r.state !== 'done',
  });
  return {
    status(id: string): Effect['state'] | undefined { return read(app.db,id)?.state; },
    onReleased(listener: (id: string) => void) { released.add(listener); return () => { released.delete(listener); }; },
    /** Call immediately before IO, outside an operation. A stable job id claims at most once. */
    beforeOutside(effect: Pick<Effect, 'id' | 'kind' | 'title'>): boolean {
      if (app.db.inTransaction) throw new Error('Outside effects must run after commit');
      let changed = false;
      const allowed = app.db.transaction(() => {
        const prior = read(app.db, effect.id);
        if (prior && (prior.kind !== effect.kind || prior.title !== effect.title)) throw new Error('Effect id reused');
        if (!prior) { app.db.prepare('INSERT INTO core_effects VALUES (?,?,?,?)').run(effect.id, effect.kind, effect.title, staging ? 'due' : 'released'); changed = true; }
        if (read(app.db, effect.id)!.state !== 'released') return false;
        app.db.prepare("UPDATE core_effects SET state='started' WHERE id=?").run(effect.id); changed = true; return true;
      })();
      if (changed) app.live.changed([{ type: 'core.effect', id: effect.id }]);
      return allowed;
    },
    finish(id: string, certain = true) {
      if (app.db.inTransaction) throw new Error('Outside effects must finish after commit');
      app.db.prepare("UPDATE core_effects SET state=? WHERE id=? AND state='started'").run(certain ? 'done' : 'uncertain', id);
      app.live.changed([{ type: 'core.effect', id }]);
    },
  };
}
export type OutsideEffects = ReturnType<typeof installEffects>;
