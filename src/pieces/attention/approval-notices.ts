import { statement } from '../../core/db/index.js';
import { createHash } from 'node:crypto';
import { OperationError, type Context, type Db } from '../../core/index.js';
import type { ApprovalNotice, ApprovalAskFiling, Ask } from './role.js';
export const approvalNoticeId = (id: string) => `approval-notice:${createHash('sha256').update(id,'utf16le').digest('hex')}`;
export function approvalNoticeRecord(n: ApprovalNotice): Ask {
  return {id:approvalNoticeId(n.id),agent:n.agent,source:{kind:'piece',id:'approvals-notices'},sourceManaged:true,
    ask:n.kind==='merge'?'Merge reported in Approvals':'Host step reported in Approvals',
    state:'resolved',resolution:'Continue in Approvals',createdAt:n.at,changedAt:n.at};
}
/** Complete bounded owning snapshot. FYI has no decision or delivery capability. */
export function approvalNoticeFiling(db: Db): Pick<ApprovalAskFiling,'syncNotices'|'pendingNotices'> {
  const project = (ctx: Context, notices: ApprovalNotice[], apply: boolean) => {
    if(ctx.db!==db || !db.inTransaction) throw new OperationError('unavailable','Notice filing needs its enclosing transaction');
    const records=new Map<string,Ask>();
    for(const notice of notices) {
      const record=approvalNoticeRecord(notice);
      if(records.has(record.id))throw new OperationError('conflict','Duplicate notice identity');
      records.set(record.id,record);
    }
    let dirty=false;
    for(const [id,record] of records) {
      const row=statement(db, 'SELECT record FROM attention_asks WHERE id=?').get(id) as {record:string}|undefined;
      if(row && row.record!==JSON.stringify(record)) {
        const old=JSON.parse(row.record) as Ask;
        if(!(old.sourceManaged && old.source.kind==='piece' && old.source.id==='approvals-notices' && old.ask==='Reported step no longer retained' && JSON.stringify({...old,ask:record.ask})===JSON.stringify(record)))throw new OperationError('conflict',old.sourceManaged && old.source.kind==='piece' && old.source.id==='approvals-notices'?'Notice event changed':'Notice belongs to another source');
      }
      if(row?.record===JSON.stringify(record))continue;
      dirty=true;
      if(apply){statement(db, 'INSERT INTO attention_asks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(id,JSON.stringify(record));ctx.changed('attention.ask',id);}
    }
    for(const row of statement(db, 'SELECT id,record FROM attention_asks').all() as {id:string;record:string}[]) {
      const old=JSON.parse(row.record) as Ask;
      if(!old.sourceManaged || old.source.kind!=='piece' || old.source.id!=='approvals-notices' || records.has(row.id))continue;
      const read=statement(db, 'SELECT 1 FROM attention_read_marks WHERE ask=? LIMIT 1').get(row.id);
      // Read facts reference this row. Keep a hidden word-free tombstone rather
      // than deleting/reassigning those facts or failing the next owning write.
      if(read && old.ask==='Reported step no longer retained' && old.resolution==='Continue in Approvals')continue;
      dirty=true;
      if(apply){
        if(read)statement(db, 'UPDATE attention_asks SET record=? WHERE id=?').run(JSON.stringify({...old,ask:'Reported step no longer retained',resolution:'Continue in Approvals'}),row.id);
        else statement(db, 'DELETE FROM attention_asks WHERE id=?').run(row.id);
        ctx.changed('attention.ask',row.id);
      }
    }
    return dirty;
  };
  return {syncNotices:(ctx,notices)=>{project(ctx,notices,true);},pendingNotices:(ctx,notices)=>project(ctx,notices,false)};
}
