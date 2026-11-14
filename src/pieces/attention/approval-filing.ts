import { z } from 'zod';
import { OperationError, type Db, type Context } from '../../core/index.js';
import { approvalAskId, type ApprovalAskFiling, type Ask } from './role.js';
/** Owning snapshots are capabilities, never a public operation or an answer hook. */
export function approvalFiling(db: Db): ApprovalAskFiling {
  const input = z.object({id:z.string(), active:z.boolean(), ask:z.string().min(1), why:z.string().optional(),
    if_yes:z.string().optional(), if_no:z.string().optional(), href:z.string().optional(), refs:z.array(z.string()).optional(),
    answers:z.enum(['words','yes-no']).optional(), agent:z.string().optional(), project:z.string().optional(), member:z.string().optional()}).strict();
  const project = (ctx: Context, inputs: Parameters<ApprovalAskFiling['sync']>[1], apply: boolean) => {
    if (ctx.db !== db || !db.inTransaction) throw new OperationError('unavailable','Approval filing needs its enclosing transaction');
    let dirty = false;
    const seen = new Set<string>();
    const save = (record: Ask, old: Ask | undefined) => {
      if (JSON.stringify(record) === JSON.stringify(old)) return;
      dirty = true;
      if (!apply) return;
      record.changedAt = ctx.now;
      db.prepare('INSERT INTO attention_asks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id,JSON.stringify(record));
      ctx.changed('attention.ask',record.id);
    };
    const withdraw = (old: Ask, audience: Pick<Ask,'agent'|'project'|'member'> = old): Ask => ({id:old.id,source:old.source,sourceManaged:true,
      ...(audience.agent !== undefined?{agent:audience.agent}:{}),...(audience.project !== undefined?{project:audience.project}:{}),...(audience.member !== undefined?{member:audience.member}:{}),
      ask:'Approval no longer needs you',state:'resolved',resolution:'Continue in Approvals',createdAt:old.createdAt,changedAt:old.changedAt});
    for (const raw of inputs) {
      const {active,...fields} = input.parse(raw), id = approvalAskId(fields.id);
      if (seen.has(id)) throw new OperationError('invalid','Duplicate approval filing');
      seen.add(id);
      const row = db.prepare('SELECT record FROM attention_asks WHERE id=?').get(id) as {record:string}|undefined;
      const old: Ask | undefined = row && JSON.parse(row.record);
      if (old && (!old.sourceManaged || old.source.kind !== 'approval' || old.source.id !== fields.id)) throw new OperationError('conflict','Ask belongs to another source');
      if (!active && !old) continue;
      // Private card wording is read only from its owning window. Even a wiring
      // mistake cannot copy the question, principal or details into Attention.
      const words = fields.member !== undefined ? {ask:'Private approval needs you'} : fields;
      const record: Ask = active ? {...words,id,source:{kind:'approval',id:fields.id},sourceManaged:true,
        ...(fields.agent !== undefined?{agent:fields.agent}:{}),...(fields.project !== undefined?{project:fields.project}:{}),...(fields.member !== undefined?{member:fields.member}:{}),
        state:'open',createdAt:old?.createdAt ?? ctx.now,changedAt:old?.changedAt ?? ctx.now} : withdraw(old!,fields);
      save(record,old);
    }
    for (const row of db.prepare('SELECT record FROM attention_asks').all() as {record:string}[]) {
      const old = JSON.parse(row.record) as Ask;
      if (old.sourceManaged && old.source.kind === 'approval' && !seen.has(old.id) && old.state !== 'resolved') save(withdraw(old),old);
    }
    return dirty;
  };
  return {sync:(ctx,inputs)=>{project(ctx,inputs,true);},pending:(ctx,inputs)=>project(ctx,inputs,false)};
}
