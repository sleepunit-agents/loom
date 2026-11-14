import { registerExportFilter } from '../../core/db/export.js';
import { registerBuiltinService } from '../../core/services.js';
import { z } from 'zod';
import { migrate, mayAct, maySee, OperationError, type Sharing } from '../../core/index.js';
import type { Foundation } from '../../core/app.js';
import { operation } from './commands.js';
import { schema as foundationSchema } from './schema/001.js';
import { schema as retrySchema } from './schema/002.js';
import { schema as slackInboxSchema } from './schema/003.js';
import { schema as discordInboxSchema } from './schema/004.js';
import { schema as filesSchema } from './schema/005.js';
import { venueSchema, routeSchema, linkSchema, statusSchema } from './model.js';
import { all, put, bumpSetup } from './store.js';
export function installBridges(app: Foundation, sharing: () => Sharing, options: { staging?: boolean } = {}) {
  registerBuiltinService(app.operations, 'bridges', ['bridges.venue', 'bridges.route', 'bridges.link', 'bridges.send']);
  migrate(app.db, 'bridges', [...foundationSchema, ...retrySchema, ...slackInboxSchema, ...discordInboxSchema, ...filesSchema]);
  registerExportFilter(app.db, 'bridges-files', table => !['bridges_files', 'bridges_file_deliveries', 'bridges_file_sources'].includes(table));
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
  operations.register(operation({ name: 'bridges.dismissSend', write: true,
    input: z.object({ id: z.string().min(1), state: z.enum(['held', 'uncertain']) }).strict(),
    output: z.object({ id: z.string() }),
    may: v => mayAct(v, { type: 'bridges.send' }, sharing(), 'household'),
    run(ctx, { id, state }) {
      const row = db.prepare('SELECT state FROM bridges_outbox WHERE id=?').get(id) as { state: string } | undefined;
      if (!row) throw new OperationError('not-found', 'No reply send');
      // Disposition is terminal, never a retry. Retain the original payload for permanent reply-id deduplication.
      if (row.state === 'dismissed') return { id };
      if (row.state !== state) throw new OperationError('conflict', 'Reply state changed; reload before dismissing');
      db.prepare("UPDATE bridges_outbox SET state='dismissed' WHERE id=?").run(id);
      ctx.changed('bridges.send', id);
      return { id };
    },
  }));
  operations.register(operation({ name: 'bridges.status',
    input: z.object({ platform: z.enum(['discord', 'slack']) }).strict(),
    output: statusSchema,
    may: v => mayAct(v, { type: 'bridges.venue' }, sharing(), 'household'),
    run(_ctx, { platform }) {
      // Include disabled setup, as the old status included every configured bot.
      // Held means refused intake, not pending retries or uncertain outgoing posts.
      const venues = all(db, 'venues').filter(v => v.platform === platform);
      const held = db.prepare(`SELECT count(*) AS n FROM bridges_inbox i
        WHERE json_extract(i.identity,'$[0]')=? AND i.state='held'`).get(platform) as { n: number };
      return { mode: options.staging ? 'staging' : 'live', agents: [...new Set(venues.map(v => v.agent))].sort(), held: held.n };
    },
  }));
  live.register({ name: 'bridges.send', ids: () => (db.prepare("SELECT id FROM bridges_outbox WHERE state NOT IN ('sent','dismissed')").all() as {id:string}[]).map(r => r.id),
    read(id,v) { if (!maySee(v,{type:'bridges.send'},sharing())) return;
      return db.prepare('SELECT id,venue,incoming,state,remote_id AS remoteId,created FROM bridges_outbox WHERE id=?').get(id) as {id:string} | undefined;
    }, inScope: r => r.state !== 'sent' && r.state !== 'dismissed',
  });
}
