/** Async mutation protocol. Installed only with an explicitly composed holder and
 * persistent independent daemon retry key. Normal next mode keeps values disabled.
 * No plaintext is retained in the journal, operation receipts or diagnostics. */
import {createHmac, createSecretKey, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {mayAct, operation, OperationError, RecoveredWrite, type Context, type Db, type Operations, type Sharing, type WriteReceipt} from '../../core/index.js';
import {secretName} from './input.js';
import {recordSecretChange} from './history.js';
import {removeSecretMetadata} from './removal.js';
import type {GrantAttention} from './index.js';
import type {HolderWrite} from './holder-store.js';

export interface AsyncSecretMutations {
  set(who: HolderWrite, name: string, value: Uint8Array, mode: 'add'|'replace'): Promise<void>;
  remove(who: HolderWrite, name: string): Promise<void>;
  hasReceipt(who: HolderWrite): Promise<boolean>;
}
interface Intent {
  sequence: number; viewer: string; id: string; operation: string; input_hash: string;
  member: string; write_id: string; holder_id: string; name: string; action: 'add'|'replace'|'removed';
  admitted_at: number; committed_at: number|null; commit_order: number|null; state: 'pending'|'committed'|'complete';
}
const unavailable = () => new OperationError('unavailable','Secret write awaits reconciliation');
const conflict = () => new OperationError('conflict','Secret write identity already reserved');
const ack = (r: Intent) => r.action === 'removed' ? {removed:true as const} : {saved:true as const};

export function installAsyncSecretValues(db: Db, operations: Operations, sharing: () => Sharing,
  holder: AsyncSecretMutations, fingerprintKey: Uint8Array, attention?: GrantAttention) {
  if (!(fingerprintKey instanceof Uint8Array) || fingerprintKey.byteLength !== 32) throw new Error('Invalid secret retry key');
  const key = createSecretKey(fingerprintKey);
  const inputHash = (text: string) => createHmac('sha256',key).update('loom-secrets-operation-v1\0').update(text).digest('hex');
  const lookup = (r: Readonly<WriteReceipt>) => db.prepare('SELECT * FROM secrets_write_intents WHERE viewer=? AND id=?').get(r.viewer,r.id) as Intent|undefined;
  function exact(r: Readonly<WriteReceipt>, row: Intent) {
    if (row.operation !== r.name || row.input_hash !== r.inputHash) throw conflict();
  }
  function reconcile(ctx: Context, row: Intent) {
    if (row.state === 'complete') return;
    if (row.state !== 'committed' || row.committed_at === null) throw unavailable();
    // The global durable lock prevents a later holder write from overtaking a
    // committed-but-unreconciled write, including after daemon/core rollback.
    const committed = {...ctx,now:row.committed_at};
    if (row.action === 'removed') removeSecretMetadata(committed,row.name,attention);
    else {
      const old = db.prepare('SELECT record FROM secrets_names WHERE id=?').get(row.name) as {record:string}|undefined;
      const record = {id:row.name,description:old ? (JSON.parse(old.record) as {description:string}).description : '',by:row.member,changedAt:row.committed_at};
      db.prepare('INSERT INTO secrets_names VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(row.name,JSON.stringify(record));
      ctx.changed('secret.name',row.name);
    }
    recordSecretChange(committed,`holder:${row.sequence}`,row.name,row.action);
    db.prepare("UPDATE secrets_write_intents SET state='complete' WHERE sequence=?").run(row.sequence);
  }
  // Core calls this for every write, across all operations and doors, before
  // permission/preparation. A pending reservation is not a success receipt.
  const recover = (ctx: Context) => {
    if (!ctx.receipt) return;
    const row = lookup(ctx.receipt); if (!row) return;
    exact(ctx.receipt,row);
    if (row.state === 'pending') return;
    // Reconciliation must not impersonate an owner who lost current authority.
    if (!mayAct(ctx.viewer,{type:'secret.name'},sharing(),'household',row.operation)) throw new OperationError('denied','Permission denied');
    reconcile(ctx,row);
    return new RecoveredWrite(ack(row),ctx.receipt.expires);
  };
  type Input = {name:string;writeId:string;value?:string;mode?:'add'|'replace'};
  function admit(ctx: Context, input: Input) {
    if (!ctx.receipt || ctx.viewer.kind !== 'member') throw new OperationError('denied','Permission denied');
    const old = lookup(ctx.receipt);
    if (old) { exact(ctx.receipt,old); return; }
    if (db.prepare('SELECT sequence FROM secrets_write_intents WHERE member=? AND write_id=?').get(ctx.viewer.id,input.writeId)) throw conflict();
    if (db.prepare("SELECT sequence FROM secrets_write_intents WHERE state <> 'complete'").get()) throw unavailable();
    const exists = !!db.prepare('SELECT id FROM secrets_names WHERE id=?').get(input.name);
    if (ctx.receipt.name === 'secrets.remove' && !exists) throw new OperationError('not-found','Secret name not found');
    if (input.mode === 'add' && exists) throw new OperationError('conflict','Secret name already exists');
    if (input.mode === 'replace' && !exists) throw new OperationError('not-found','Secret name not found');
    db.prepare('INSERT INTO secrets_write_intents (viewer,id,operation,input_hash,member,write_id,holder_id,name,action,admitted_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(ctx.receipt.viewer,ctx.receipt.id,ctx.receipt.name,ctx.receipt.inputHash,ctx.viewer.id,input.writeId,randomUUID(),input.name,input.mode ?? 'removed',ctx.now,'pending');
  }
  const running = new Map<number,Promise<void>>();
  async function prepare(input: Input, context: {readonly receipt?:Readonly<WriteReceipt>}) {
    const receipt = context.receipt; if (!receipt) throw unavailable();
    const row = lookup(receipt); if (!row) throw unavailable(); exact(receipt,row);
    const current = running.get(row.sequence); if (current) return current;
    const work = (async () => {
      if (row.state !== 'pending') return;
      const who = {member:row.member,writeId:row.holder_id};
      // TRUE is trusted only because admission already bound this unique id to
      // the complete keyed input. FALSE never clears or changes a reservation.
      const found:unknown = await holder.hasReceipt(who);
      if (typeof found !== 'boolean') throw unavailable();
      if (!found) {
        let bytes:Buffer|undefined;
        try {
          const result:unknown = row.action === 'removed' ? await holder.remove(who,row.name)
            : await holder.set(who,row.name,bytes=Buffer.from(input.value!),row.action);
          if (result !== undefined) throw unavailable();
        } finally {bytes?.fill(0);}
      }
      db.transaction(() => {
        db.prepare("UPDATE secrets_write_intents SET state='committed', committed_at=?, commit_order=(SELECT coalesce(max(commit_order),0)+1 FROM secrets_write_intents) WHERE sequence=? AND state='pending'").run(operations.clock.now(),row.sequence);
      })();
    })();
    running.set(row.sequence,work);
    try {await work;} catch {throw unavailable();} finally {running.delete(row.sequence);}
  }
  const base = {write:true,inputHash,recheckPolicy:true,recover,admit,prepare,
    may:(v:Context['viewer'])=>v.kind==='member' && mayAct(v,{type:'secret.name'},sharing(),'household','secrets.set'),
    run(){throw unavailable();},
  };
  operations.register(operation({...base,name:'secrets.set',
    input:z.object({name:secretName,writeId:z.uuid(),mode:z.enum(['add','replace']),value:z.string().refine(v=>Buffer.byteLength(v)>0 && Buffer.byteLength(v)<=65536)}).strict(),
    output:z.object({saved:z.literal(true)}),
  }));
  operations.register(operation({...base,name:'secrets.remove',
    may:v=>v.kind==='member' && mayAct(v,{type:'secret.name'},sharing(),'household','secrets.remove'),
    input:z.object({name:secretName,writeId:z.uuid()}).strict(),output:z.object({removed:z.literal(true)}),
  }));
}
