import { registerBuiltinService } from '../../core/services.js';
import { z } from 'zod';
import { migrate, mayAct, maySee, type Sharing } from '../../core/index.js';
import type { Foundation } from '../../core/app.js';
import { operation } from './commands.js';
import { schema } from './schema/001.js';
import { venueSchema, routeSchema, linkSchema } from './model.js';
import { all, put, bumpSetup } from './store.js';
export function installBridges(app: Foundation, sharing: () => Sharing) {
  registerBuiltinService(app.operations, 'bridges', ['bridges.venue', 'bridges.route', 'bridges.link', 'bridges.send']);
  migrate(app.db, 'bridges', schema);
  const { db, operations, live } = app;
  // Connections and routing are household setup; person links are authority, not descriptive People handles.
  for (const [table, input, type] of [
    ['venues', venueSchema, 'bridges.venue'], ['routes', routeSchema, 'bridges.route'], ['links', linkSchema, 'bridges.link'],
  ] as const) {
    operations.register(operation({ name: `bridges.put${table[0].toUpperCase()}${table.slice(1)}`, write: true,
      input: input as z.ZodType<import('./store.js').Records[keyof import('./store.js').Records]>, output: z.object({ id: z.string() }),
      may: v => mayAct(v, { type }, sharing(), 'household'),
      run(ctx, record) { put(db, table, record); ctx.changed(type, record.id); return { id: record.id }; },
    }));
    operations.register(operation({ name: `bridges.remove${table[0].toUpperCase()}${table.slice(1)}`, write: true,
      input: z.object({ id: z.string() }), output: z.object({ id: z.string() }),
      may: v => mayAct(v, { type }, sharing(), 'household'),
      run(ctx, { id }) {
        if (table === 'venues') {
          db.prepare("UPDATE bridges_inbox SET state='held',reason='venue removed' WHERE venue=? AND state='pending'").run(id);
          const sends = db.prepare("SELECT id FROM bridges_outbox WHERE venue=? AND state='pending'").all(id) as {id:string}[];
          for (const send of sends) ctx.changed('bridges.send',send.id);
          db.prepare("UPDATE bridges_outbox SET state='held' WHERE venue=? AND state='pending'").run(id);
        }
        bumpSetup(db);
        db.prepare(`DELETE FROM bridges_${table} WHERE id=?`).run(id); ctx.changed(type,id); return { id };
      },
    }));
    live.register({ name: type, ids: () => all(db,table).map(r => r.id), read: (id,v) => {
      if (!maySee(v,{ type },sharing())) return;
      const r = all(db,table).find(r => r.id === id); if (!r) return;
      if (table !== 'venues') return { ...r };
      const status = db.prepare('SELECT state,changed FROM bridges_status WHERE id=?').get(id) as {state: string;changed: number} | undefined;
      const traffic = db.prepare('SELECT count(*) AS received, sum(state=\'delivered\') AS delivered, sum(state=\'held\') AS held FROM bridges_inbox WHERE venue=? AND received>=?').get(id, operations.clock.now()-86400_000) as {received:number;delivered:number;held:number};
      // Only secret REFERENCES, never values, are part of setup records.
      return { ...r, connection: status?.state ?? 'disconnected', changedAt: status?.changed ?? 0, ...traffic };
    }, inScope: () => true });
  }
  live.register({ name: 'bridges.send', ids: () => (db.prepare("SELECT id FROM bridges_outbox WHERE state NOT IN ('sent','dismissed')").all() as {id:string}[]).map(r => r.id),
    read(id,v) { if (!maySee(v,{type:'bridges.send'},sharing())) return;
      return db.prepare('SELECT id,venue,incoming,state,remote_id AS remoteId,created FROM bridges_outbox WHERE id=?').get(id) as {id:string} | undefined;
    }, inScope: r => r.state !== 'sent' && r.state !== 'dismissed',
  });
}
