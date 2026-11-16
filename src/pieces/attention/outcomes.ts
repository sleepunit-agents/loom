import { statement } from '../../core/db/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mayAct, maySee, type Db, type Live, type LiveRecord, type Operations, type Result, type Sharing, type Viewer } from '../../core/index.js';
import { operation } from '../../core/index.js';
export interface ActionOutcome {
  id: string; member: string; at: number; order: number; ok: boolean; text: string;
  source: string; sourceLabel: string; page: string; operation: string; readAt?: number;
}
/** Explicit safe messages only: never serialize input, result values, private
 * question/reply words, errors, credentials, one-time links or CLI stdout. */
interface Action {label: string; page: string; source: string; sourceLabel: string}
function group(source: string, sourceLabel: string, page: string, labels: Record<string,string>): [string,Action][] {
  return Object.entries(labels).map(([verb,label]) => [`${source}.${verb}`,{label,page,source,sourceLabel}]);
}
// Exact operation allowlist, never a prefix: new commands require an explicit
// output/privacy audit before they may leave a lasting member-local receipt.
const actions: Record<string, Action> = Object.fromEntries([
  ...group('tasks','Tasks','/p/tasks-preview',{create:'Create task',claim:'Claim task',unclaim:'Unclaim task',close:'Close task',reopen:'Reopen task',update:'Update task',comment:'Comment on task',link:'Link tasks',unlink:'Unlink tasks',delete:'Delete task'}),
  ...group('attention','Inbox','/p/inbox-preview',{answer:'Record answer'}),
  ...group('changes','Changes','/p/changes-preview',{answer:'Record change decision',refresh:'Request changes refresh'}),
  ...group('approvals','Approvals','/p/approvals-preview',{answer:'Record approval decision','every-time':'Save exact standing approval',always:'Save project standing approval','set-rule':'Save approval rule','standing-off':'Turn off standing approval'}),
  ...group('clock','Clock','/p/clock-preview',{in:'Schedule wake',cancel:'Cancel wake',now:'Request wake now',askVouch:'Request work ownership decision',vouch:'Record work ownership',pause:'Pause scheduled work',resume:'Resume scheduled work',scheduleSet:'Save schedule',scheduleRemove:'Remove schedule',scheduleRun:'Request schedule run',laneSet:'Save lane',laneAssign:'Assign lane',laneRemove:'Remove lane',scheduleLocalFromWindow:'Schedule saved local work'}),
  ...group('household','Household setup','/p/setup-preview',{setProfile:'Save agent description',requestProfile:'Request agent description',setAgentAccounts:'Save agent account names',setSettings:'Save household settings',propose:'Propose household change',addAgent:'Register existing agent',setMember:'Save member ownership',setMemberProjects:'Save member projects',removeMember:'Remove member'}),
  ...group('household','Sharing','/p/sharing-preview',{createProject:'Create project',setProjectMembers:'Save project members',setProjectAgents:'Save project agents'}),
  ...group('mind','Knowledge','/p/knowledge-preview',{knowledgeAdd:'Add knowledge page',knowledgeVerify:'Confirm knowledge page',knowledgeRecheck:'Request knowledge recheck',knowledgeEdit:'Edit knowledge page',knowledgeRestore:'Restore knowledge page version'}),
  ...group('mind','People','/p/people-preview',{personAdd:'Add person'}),
  ...group('bridges','Bridges','/p/bridges-preview',{putVenues:'Save bridge venue',removeVenues:'Remove bridge venue',putRoutes:'Save bridge route',removeRoutes:'Remove bridge route',putLinks:'Save bridge person link',removeLinks:'Remove bridge person link',dismissSend:'Dismiss bridge send',file:'Read bridge attachment'}),
  ...group('core','Staging','/p/staging',{releaseEffect:'Release held effect'}),
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
    const row=statement(db, 'SELECT record FROM attention_outcomes WHERE id=?').get(id) as {record:string}|undefined;
    return row && JSON.parse(row.record) as ActionOutcome;
  };
  live.observeWindowCalls(({viewer,name,id,retryUntil,result}) => {
    const action=Object.hasOwn(actions,name) ? actions[name] : undefined;
    if (name==='attention.answer' && !result.ok && result.code==='conflict' && result.message==='Ask is no longer open') return;
    if (!action || !can(viewer) || !id || id.length>200) return;
    const key=`outcome-${createHash('sha256').update(JSON.stringify([viewer.id,id,retryUntil ?? 'attempt'])).digest('hex')}`;
    const changes: {type:string;id:string}[]=[];
    db.transaction(() => {
      const now=operations.clock.now();
      statement(db, 'DELETE FROM attention_outcome_seen WHERE expires<=?').run(now);
      if (statement(db, 'SELECT id FROM attention_outcome_seen WHERE id=?').get(key)) return;
      const ok=succeeded(name,result);
      const record: ActionOutcome={id:`outcome-${randomUUID()}`,member:viewer.id,at:now,order:0,ok,text:`${action.label}: ${ok?'saved':'could not be saved'}.`,source:action.source,sourceLabel:action.sourceLabel,page:action.page,operation:name};
      const inserted=statement(db, 'INSERT INTO attention_outcomes(id,member,record) VALUES (?,?,?)').run(record.id,viewer.id,JSON.stringify(record));
      record.order=Number(inserted.lastInsertRowid);
      statement(db, 'UPDATE attention_outcomes SET record=? WHERE id=?').run(JSON.stringify(record),record.id);
      statement(db, 'INSERT INTO attention_outcome_seen VALUES (?,?)').run(key,retryUntil ?? now+30*86400_000);
      changes.push({type:'attention.outcome',id:record.id});
      const excess=statement(db, 'SELECT id FROM attention_outcomes WHERE member=? ORDER BY ordinal DESC LIMIT -1 OFFSET 50').all(viewer.id) as {id:string}[];
      for (const row of excess) { statement(db, 'DELETE FROM attention_outcomes WHERE id=?').run(row.id); changes.push({type:'attention.outcome',id:row.id}); }
    })();
    if(changes.length) live.changed(changes);
  });
  operations.register(operation({name:'attention.outcomes',input:z.object({}).strict(),output:z.unknown(),may:can,
    run(ctx) {return (statement(db, 'SELECT record FROM attention_outcomes WHERE member=? ORDER BY ordinal DESC').all(ctx.viewer.id) as {record:string}[]).map(row=>JSON.parse(row.record));},
  }));
  operations.register(operation({name:'attention.readOutcome',write:true,input:z.object({id:z.string().min(1).max(200)}).strict(),output:z.unknown(),
    may(viewer,input){const record=read(input.id);return !!record && can(viewer) && mayAct(viewer,scope(record.member),sharing());},
    run(ctx,input){const record=read(input.id)!;if(record.readAt===undefined){record.readAt=ctx.now;statement(db, 'UPDATE attention_outcomes SET record=? WHERE id=?').run(JSON.stringify(record),record.id);ctx.changed('attention.outcome',record.id);}return {read:true};},
  }));
  live.register({name:'attention.outcome',
    ids:()=> (statement(db, 'SELECT id FROM attention_outcomes ORDER BY ordinal DESC').all() as {id:string}[]).map(row=>row.id),
    read(id,viewer){const record=read(id);return record && maySee(viewer,scope(record.member),sharing()) ? record as unknown as LiveRecord : undefined;},
    inScope:()=>true,
  });
}
