import {OperationError, type Context} from '../../core/index.js';
/** Always registered, even when no async holder is configured. A daemon restart
 * without its holder/retry key must not free an existing global viewer/id. */
export function guardSecretWriteIntent(ctx: Context): undefined {
  if (!ctx.receipt) return;
  const row = ctx.db.prepare('SELECT operation,input_hash FROM secrets_write_intents WHERE viewer=? AND id=?')
    .get(ctx.receipt.viewer,ctx.receipt.id) as {operation:string;input_hash:string}|undefined;
  if (row && (row.operation !== ctx.receipt.name || row.input_hash !== ctx.receipt.inputHash))
    throw new OperationError('conflict','Secret write identity already reserved');
  // Set/remove check UUID reuse before admission's global lock. All other
  // Secrets writes must also wait: a later description/grant/policy edit cannot
  // be silently overtaken by recovery of an earlier holder mutation.
  if (!row && ctx.receipt.name.startsWith('secrets.') && !['secrets.set','secrets.remove'].includes(ctx.receipt.name)
    && ctx.db.prepare("SELECT sequence FROM secrets_write_intents WHERE state <> 'complete'").get())
    throw new OperationError('unavailable','Secret write awaits reconciliation');
}
