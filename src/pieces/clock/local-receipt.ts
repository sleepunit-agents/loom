/** Clock owns both public and trusted standing receipt retention. */
import type { Context } from '../../core/index.js';
export function saveLocalReceipt(ctx:Context,result:unknown) {
 const receipt=ctx.receipt!;
 ctx.db.prepare('INSERT INTO clock_meta(key,value) VALUES (?,?)').run(
  `local-standing-receipt:${receipt.viewer}:${receipt.id}`,
  JSON.stringify({name:receipt.name,hash:receipt.inputHash,result}));
}
