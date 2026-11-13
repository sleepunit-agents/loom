import { z } from 'zod';
import { OperationError, type Db } from '../../core/index.js';
import { boxRecord } from './records.js';
import { runtimeStore } from './store.js';

const localIdentity = boxRecord.pick({ id: true, name: true, owner: true }).strict();
const report = z.object({
  facts: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}(:[A-Za-z0-9._ +-]{1,64})?$/)).max(32).optional(),
}).strict();
const time = z.number().int().safe();
function requireTransaction(db: Db) {
  if (!db.inTransaction) throw new Error('Runtime lifecycle writes require a transaction');
}

/** Internal setup helper, NOT an operation or authorization boundary. Trusted
 * composition must supply explicit runner identity and validate its owner before
 * calling. Never infer a runner from the daemon's hostname or environment.
 * Caller owns the transaction and must publish runtime.box only when changed.
 */
export function initializeLocalBox(db: Db, input: z.infer<typeof localIdentity>, now: number) {
  requireTransaction(db);
  const identity = localIdentity.parse(input);
  time.parse(now);
  const store = runtimeStore(db);
  const before = store.read('box', identity.id);
  // Never turn an enrolled remote runner into an irrevocable local runner, nor
  // silently move identity after a host rename or owner change.
  if (before && (!before.local || before.revokedAt !== undefined || before.name !== identity.name || before.owner !== identity.owner))
    throw new OperationError('conflict', 'Existing box does not match the explicit local identity');
  if (store.ids('box').some(id => id !== identity.id && store.read('box', id)!.local))
    throw new OperationError('conflict', 'Another local box is already registered');
  if (before) return { box: identity.id, changed: false };
  const changed = store.put('box', {
    ...identity, local: true, mayHost: '*', lentTo: [], facts: [], labels: [],
    alwaysOn: true, reportOnly: false, createdAt: now,
  }, now);
  return { box: identity.id, changed };
}

/** Internal metadata update, NOT runner authentication. A future operation must
 * obtain boxId from a centrally authenticated runner principal, never body input
 * or a display name, before calling. No credential issuance, dispatch or report
 * forwarding here. Caller owns the transaction and committed notification.
 */
export function hearBox(db: Db, boxId: string, input: z.infer<typeof report>, now: number) {
  requireTransaction(db);
  const checked = report.parse(input);
  time.parse(now);
  const store = runtimeStore(db);
  const before = store.read('box', boxId);
  if (!before || before.revokedAt !== undefined) throw new OperationError('denied', 'This box is not enrolled');
  const { changedAt: _changedAt, ...value } = before;
  const changed = store.put('box', {
    ...value, ...(checked.facts === undefined ? {} : { facts: [...new Set(checked.facts)] }), lastSeen: now,
  }, now);
  return { box: boxId, changed };
}
