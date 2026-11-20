import { z } from 'zod';
import { mayAct, operation, OperationError, type Context, type Db, type Live, type Operations, type Sharing, type Viewer } from '../../core/index.js';
import { secretName } from './input.js';

export interface SecretChange {
  id: string;
  name: string;
  action: 'add' | 'replace' | 'removed';
  by: string;
  at: number;
}
/** Called only by trusted value operations, in their metadata transaction.
 * Explicit fields prevent holder output, descriptions or values entering history.
 */
export function recordSecretChange(ctx: Context, id: string, name: string, action: SecretChange['action']) {
  const old = ctx.db.prepare('SELECT record FROM secrets_changes WHERE id=?').get(id) as {record: string} | undefined;
  if (old) {
    const change = JSON.parse(old.record) as SecretChange;
    if (change.name !== name || change.action !== action || change.by !== ctx.viewer.id) throw new OperationError('conflict', 'Change write id was already used');
    return;
  }
  const record: SecretChange = {id, name, action, by: ctx.viewer.id, at: ctx.now};
  ctx.db.prepare('INSERT INTO secrets_changes VALUES (?,?)').run(id, JSON.stringify(record));
  ctx.changed('secret.change', id);
}
export function installSecretHistory(db: Db, operations: Operations, live: Live, sharing: () => Sharing) {
  const owner = (viewer: Viewer) => mayAct(viewer, {type: 'secret.change'}, sharing(), 'household', 'secrets.history');
  operations.register(operation({name: 'secrets.history', input: z.object({name: secretName}).strict(), output: z.unknown(),
    may: owner, run: (_ctx, input) => (db.prepare('SELECT record FROM secrets_changes ORDER BY id').all() as {record: string}[])
      .map(row => JSON.parse(row.record) as SecretChange).filter(row => row.name === input.name).sort((a,b) => a.at-b.at || a.id.localeCompare(b.id)),
  }));
  live.register({name: 'secret.change', inScope: () => true,
    ids: () => (db.prepare('SELECT id FROM secrets_changes ORDER BY id').all() as {id: string}[]).map(row => row.id),
    read(id, viewer) {
      if (!owner(viewer)) return;
      const row = db.prepare('SELECT record FROM secrets_changes WHERE id=?').get(id) as {record: string} | undefined;
      return row ? {...JSON.parse(row.record) as SecretChange} : undefined;
    },
  });
}
