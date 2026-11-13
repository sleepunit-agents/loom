import {OperationError, type Context} from '../../core/index.js';
/** Always registered, even when no async holder is configured. A daemon restart
 * without its holder/retry key must not free an existing global viewer/id. */
export function guardSecretWriteIntent(ctx: Context): undefined {
  if (!ctx.receipt) return;
  const row = ctx.db.prepare('SELECT operation,input_hash FROM secrets_write_intents WHERE viewer=? AND id=?')
    .get(ctx.receipt.viewer,ctx.receipt.id) as {operation:string;input_hash:string}|undefined;
  if (row && (row.operation !== ctx.receipt.name || row.input_hash !== ctx.receipt.inputHash))
    throw new OperationError('conflict','Secret write identity already reserved');
}
