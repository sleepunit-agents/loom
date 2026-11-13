import { z } from 'zod';
import { operation, mayAct, OperationError, type Db, type Operations, type Sharing } from '../../core/index.js';
import { grantsRole } from './index.js';
import type { GrantContext } from './role.js';
import type { KeyHolder } from './keyholder.js';
import { secretName as name } from './input.js';
import { recordSecretChange } from './history.js';
import { removeSecretMetadata } from './removal.js';
/** Registry values flow one way. Never return the holder's output, even on failure.
 * The registry stores only an input hash and this fixed acknowledgement.
 */
export function installSecretValues(db: Db, operations: Operations, sharing: () => Sharing, holder: KeyHolder) {
  operations.register(operation({ name: 'secrets.remove', write: true,
    input: z.object({ name, writeId: z.uuid() }).strict(), output: z.object({ removed: z.literal(true) }),
    may: v => mayAct(v, { type: 'secret.name' }, sharing(), 'household', 'secrets.remove'),
    run(ctx, input) {
      const receipt = `remove:${ctx.viewer.id}:${input.writeId}`;
      const old = db.prepare('SELECT value FROM secrets_meta WHERE key=?').get(receipt) as { value: string } | undefined;
      if (old) {
        if (old.value !== input.name) throw new OperationError('conflict', 'Removal write id was already used');
        return { removed: true as const };
      }
      if (!db.prepare('SELECT id FROM secrets_names WHERE id=?').get(input.name)) throw new OperationError('not-found', 'Secret name not found');
      try {
        const acknowledgement: unknown = holder.remove(input.name, receipt);
        if (acknowledgement instanceof Promise) {
          void acknowledgement.catch(() => {});
          throw new Error('Removal must acknowledge synchronously');
        }
      }
      catch { throw new OperationError('unavailable', 'Key holder could not remove the secret'); }
      recordSecretChange(ctx, receipt, input.name, 'removed');
      removeSecretMetadata(ctx, input.name);
      db.prepare('INSERT INTO secrets_meta VALUES (?,?)').run(receipt, input.name);
      return { removed: true as const };
    },
  }));
  operations.register(operation({ name: 'secrets.set', write: true,
    input: z.object({ name, value: z.string().refine(v => Buffer.byteLength(v) > 0 && Buffer.byteLength(v) <= 64 * 1024), mode: z.enum(['add', 'replace']), writeId: z.uuid() }).strict(),
    output: z.object({ saved: z.literal(true) }),
    may: v => mayAct(v, { type: 'secret.name' }, sharing(), 'household', 'secrets.set'),
    run(ctx, input) {
      const bytes = Buffer.from(input.value);
      try {
        // The holder binds this stable write id to the full input and authenticated member.
        // It must survive daemon retries when a holder write succeeded before DB commit.
        // Values are deliberately absent from all metadata below.
        holder.set(input.name, bytes, input.mode, `set:${ctx.viewer.id}:${input.writeId}`);
      } catch { throw new OperationError('unavailable', 'Key holder could not save the secret'); }
      finally { bytes.fill(0); }
      const record = { id: input.name, description: '', by: ctx.viewer.id, changedAt: ctx.now };
      const existing = db.prepare('SELECT record FROM secrets_names WHERE id=?').get(input.name) as { record: string } | undefined;
      if (existing) record.description = (JSON.parse(existing.record) as { description: string }).description;
      db.prepare('INSERT INTO secrets_names VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(input.name, JSON.stringify(record));
      recordSecretChange(ctx, `set:${ctx.viewer.id}:${input.writeId}`, input.name, input.mode);
      ctx.changed('secret.name', input.name); return { saved: true as const };
    },
  }));
}
/** Runtime-only seam, never offered on any browser/API registry door.
 * Sink names are assigned by the authenticated runtime, never a caller's path.
 */
export function handSecret(db: Db, holder: KeyHolder, agent: string, name: string, sink: string, now: number, context?: GrantContext): boolean {
  if (!grantsRole(db).mayUse(agent, { kind: 'secret', target: name }, now, context)) return false;
  try { holder.handTo(name, sink); return true; } catch { return false; }
}
