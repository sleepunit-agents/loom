import { createHash } from 'node:crypto';
import { z } from 'zod';
import { mayAct, maySee, type Db, type Live, type LiveRecord, type Operations, type Result, type Sharing, type Viewer } from '../../core/index.js';
import { operation } from './commands.js';
export interface ActionOutcome {
  id: string; member: string; at: number; order: number; ok: boolean; text: string;
  source: string; sourceLabel: string; page: string; operation: string; readAt?: number;
}
/** Explicit safe messages only: never serialize input, result values, private
 * question/reply words, errors, credentials, one-time links or CLI stdout. */
const actions: Record<string, {label: string; page: string; source: string; sourceLabel: string}> = Object.fromEntries([
  ...Object.entries({create:'Create task',claim:'Claim task',unclaim:'Unclaim task',close:'Close task',reopen:'Reopen task',update:'Update task',comment:'Comment on task',link:'Link tasks',unlink:'Unlink tasks',delete:'Delete task'})
    .map(([verb,label]) => [`tasks.${verb}`,{label,page:'/p/tasks-preview',source:'tasks',sourceLabel:'Tasks'}]),
  ['attention.answer',{label:'Record answer',page:'/p/inbox-preview',source:'attention',sourceLabel:'Inbox'}],
]);
function succeeded(name: string, result: Result): boolean {
  if (!result.ok) return false;
  // The Tasks CLI-compatible envelope can report a domain rejection over a
  // successful operation transport. That is an error, never a success notice.
  if (name.startsWith('tasks.')) return (result.value as {result?:{ok?:boolean}} | null)?.result?.ok === true;
  return true;
}
export function installOutcomes(db: Db, operations: Operations, live: Live, sharing: () => Sharing) {
  const scope = (member: string) => ({type:'attention.outcome',member});
  const can = (viewer: Viewer) => viewer.kind === 'member' && mayAct(viewer,scope(viewer.id),sharing());
  const read = (id: string): ActionOutcome | undefined => {
    const row=db.prepare('SELECT record FROM attention_outcomes WHERE id=?').get(id) as {record:string}|undefined;
    return row && JSON.parse(row.record) as ActionOutcome;
  };
  live.observeWindowCalls(({viewer,name,id,result}) => {
    const action=Object.hasOwn(actions,name) ? actions[name] : undefined;
    if (name==='attention.answer' && !result.ok && result.code==='conflict' && result.message==='Ask is no longer open') return;
    if (!action || !can(viewer) || !id || id.length>200) return;
    const key=`outcome-${createHash('sha256').update(JSON.stringify([viewer.id,id])).digest('hex')}`;
    const changes: {type:string;id:string}[]=[];
    db.transaction(() => {
      const now=operations.clock.now();
      db.prepare('DELETE FROM attention_outcome_seen WHERE expires<=?').run(now);
      if (db.prepare('SELECT id FROM attention_outcome_seen WHERE id=?').get(key)) return;
      const ok=succeeded(name,result);
      const record: ActionOutcome={id:key,member:viewer.id,at:now,order:0,ok,text:`${action.label}: ${ok?'saved':'could not be saved'}.`,source:action.source,sourceLabel:action.sourceLabel,page:action.page,operation:name};
      const inserted=db.prepare('INSERT INTO attention_outcomes(id,member,record) VALUES (?,?,?)').run(key,viewer.id,JSON.stringify(record));
      record.order=Number(inserted.lastInsertRowid);
      db.prepare('UPDATE attention_outcomes SET record=? WHERE id=?').run(JSON.stringify(record),key);
      db.prepare('INSERT INTO attention_outcome_seen VALUES (?,?)').run(key,now+30*86400_000);
      changes.push({type:'attention.outcome',id:key});
      const excess=db.prepare('SELECT id FROM attention_outcomes WHERE member=? ORDER BY ordinal DESC LIMIT -1 OFFSET 50').all(viewer.id) as {id:string}[];
      for (const row of excess) { db.prepare('DELETE FROM attention_outcomes WHERE id=?').run(row.id); changes.push({type:'attention.outcome',id:row.id}); }
    })();
    if(changes.length) live.changed(changes);
  });
  operations.register(operation({name:'attention.outcomes',input:z.object({}).strict(),output:z.unknown(),may:can,
    run(ctx) {return (db.prepare('SELECT record FROM attention_outcomes WHERE member=? ORDER BY ordinal DESC').all(ctx.viewer.id) as {record:string}[]).map(row=>JSON.parse(row.record));},
  }));
  operations.register(operation({name:'attention.readOutcome',write:true,input:z.object({id:z.string().min(1).max(200)}).strict(),output:z.unknown(),
    may(viewer,input){const record=read(input.id);return !!record && can(viewer) && mayAct(viewer,scope(record.member),sharing());},
    run(ctx,input){const record=read(input.id)!;if(record.readAt===undefined){record.readAt=ctx.now;db.prepare('UPDATE attention_outcomes SET record=? WHERE id=?').run(JSON.stringify(record),record.id);ctx.changed('attention.outcome',record.id);}return {read:true};},
  }));
  live.register({name:'attention.outcome',
    ids:()=> (db.prepare('SELECT id FROM attention_outcomes ORDER BY ordinal DESC').all() as {id:string}[]).map(row=>row.id),
    read(id,viewer){const record=read(id);return record && maySee(viewer,scope(record.member),sharing()) ? record as unknown as LiveRecord : undefined;},
    inScope:()=>true,
  });
}
