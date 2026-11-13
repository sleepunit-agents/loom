import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mayAct, operation, type Db, type Live, type Operations, type Sharing, type Viewer } from '../../core/index.js';
import { secretName } from './input.js';
import type { GrantContext } from './role.js';

export interface SecretUsage {
  id: string;
  name: string;
  action: 'read' | 'issue' | 'service-use';
  by: {kind: 'agent' | 'service'; id: string};
  at: number;
  state: 'started' | 'released' | 'failed';
  house?: string;
  service?: string;
}
/** Trusted composition only. No holder output, sink, callback result or error is
 * accepted. Persist an attempt before any credential can leave the holder; an
 * interrupted attempt stays started and never counts as a confirmed use.
 */
export function beginSecretUsage(db: Db, live: Live, name: string, action: SecretUsage['action'], by: SecretUsage['by'], at: number, context?: GrantContext) {
  if (db.inTransaction) throw new Error('Credential use cannot run inside a metadata transaction');
  const record: SecretUsage = {id: `use-${randomUUID()}`, name, action, by: {kind: by.kind, id: by.id}, at, state: 'started',
    ...(context ? {house: context.house, ...(context.service === undefined ? {} : {service: context.service})} : {})};
  const save = () => {
    db.prepare('INSERT INTO secrets_uses VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, name, JSON.stringify(record));
    live.changed([{type: 'secret.use', id: record.id}]);
  };
  save();
  return {finish(state: 'released' | 'failed') {record.state = state; save();}};
}
export function installSecretUsage(db: Db, operations: Operations, live: Live, sharing: () => Sharing) {
  const owner = (viewer: Viewer) => mayAct(viewer, {type: 'secret.use'}, sharing(), 'household', 'secrets.usage');
  operations.register(operation({name: 'secrets.usage', input: z.object({name: secretName}).strict(), output: z.unknown(),
    may: owner, run: (_ctx, input) => {
      const events = (db.prepare('SELECT record FROM secrets_uses WHERE name=? ORDER BY id').all(input.name) as {record: string}[])
        .map(row => JSON.parse(row.record) as SecretUsage).sort((a,b) => a.at-b.at || a.id.localeCompare(b.id));
      const released = events.filter(e => e.state === 'released');
      return {events, count: released.length, lastUsedAt: released.at(-1)?.at ?? null};
    },
  }));
  live.register({name: 'secret.use', inScope: () => true,
    ids: () => (db.prepare('SELECT id FROM secrets_uses ORDER BY id').all() as {id: string}[]).map(row => row.id),
    read(id, viewer) {
      if (!owner(viewer)) return;
      const row = db.prepare('SELECT record FROM secrets_uses WHERE id=?').get(id) as {record: string} | undefined;
      return row ? {...JSON.parse(row.record) as SecretUsage} : undefined;
    },
  });
}
