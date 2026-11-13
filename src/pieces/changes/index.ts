import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { migrate, operation, maySee, mayAct, OperationError, type Db, type Operations, type Live, type Sharing, type Viewer } from '../../core/index.js';
import { tasksRole } from '../tasks/role.js';
import { schema } from './schema.js';
import { active, week, targetOf, taskLinks, waitsOn, stateLine, citations, groups, type Change, type Attribution, type CitingTask } from './model.js';
import { loadChanges } from './store.js';
import type { Approvals } from './roles.js';
const emptyAttribution:Attribution={agents:{},ownerLogins:[]};
export function installChanges(db:Db, operations:Operations, live:Live, sharing:()=>Sharing, options:{onRefresh?:()=>void; approvals?:Approvals; attribution?:()=>Attribution}={}) {
 migrate(db,'changes',schema);
 const scope=(c:Change)=>({type:'change',...(c.project?{project:c.project}:{}),...(c.agent?{agent:c.agent}:{})});

 const see=(v:Viewer,c:Change)=>maySee(v,scope(c),sharing());
 const access=(v:Viewer,op:string)=>v.kind!=='service'||mayAct(v,{type:'change'},sharing(),'act',op);
 const all=(v:Viewer)=>loadChanges(db).filter(c=>see(v,c));
 const readTasks=(v:Viewer):CitingTask[]=>{
  const answer=tasksRole(operations).call(v,'export',{});
  return answer.ok ? ((answer.value as {result:{tasks?:CitingTask[]}}).result.tasks ?? []) : [];
 };
 const decorate=(c:Change,v:Viewer)=>{
  const rule=c.agent?options.approvals?.rule(v,c.agent,targetOf(c)):undefined;
  const wait=waitsOn(c,rule),attribution=options.attribution?.()??emptyAttribution;
  return {...c,...wait,words:stateLine(c,wait.words),...taskLinks(c,readTasks(v),[...Object.keys(attribution.agents),...(attribution.taskOwner?[attribution.taskOwner]:[])]),...(rule?{rule}:{})};
 };
 for(const verb of ['list','references','cited-by','project-feed','thread-feed','show'] as const) operations.register(operation({
  name:`changes.${verb}`,cli:{name:verb,positional:verb==='cited-by'?['task']:verb==='show'?['id']:[],flags:{project:'project',since:'since',conversation:'conversation'}},
  input:z.object({id:z.string().optional(),task:z.string().optional(),project:z.string().optional(),since:z.string().optional(),conversation:z.string().optional(),references:z.array(z.string()).max(200).optional()}).passthrough(),output:z.unknown(),
  may:(v,input)=>access(v,`changes.${verb}`)&&(verb!=='show'||!loadChanges(db).find(c=>c.id===input.id)||see(v,loadChanges(db).find(c=>c.id===input.id)!)),
  run(ctx,input){
   let changes=all(ctx.viewer).filter(c=>active(c,ctx.now)).map(c=>decorate(c,ctx.viewer));
   if(verb==='show') { const c=all(ctx.viewer).find(c=>c.id===input.id); if(!c) throw new OperationError('not-found','Change not found');return decorate(c,ctx.viewer); }
   if(verb==='references') {const wanted=new Set((input.references??[]).flatMap(r=>citations(r)));return changes.filter(c=>wanted.has(c.id));}
   if(verb==='cited-by') return changes.filter(c=>c.tasks.some(t=>t.id===input.task));
   if(verb==='project-feed') changes=changes.filter(c=>c.project===input.project&&(!input.since||Date.parse(c.updated??'')>=Date.parse(input.since)));
   if(verb==='thread-feed') {const wanted=new Set((input.references??[]).flatMap(citations));return {items:changes.filter(c=>c.conversation===input.conversation||wanted.has(c.id)).sort((a,b)=>Number(b.conversation===input.conversation)-Number(a.conversation===input.conversation)).slice(0,50)};}
   changes.sort((a,b)=>groups.indexOf(a.group)-groups.indexOf(b.group)||Date.parse(b.updated??'')-Date.parse(a.updated??''));
   return verb==='project-feed'?{groups:groups.map(group=>({title:group,waiting:group==='you',items:changes.filter(c=>c.group===group)})).filter(g=>g.items.length)}:changes;
  }
 }));
 operations.register(operation({name:'changes.refresh',write:true,cli:{name:'refresh',write:true},input:z.object({}).passthrough(),output:z.object({message:z.string()}),
  may:v=>mayAct(v,{type:'change'},sharing(),'household','changes.refresh'),
  run(ctx){db.prepare('INSERT INTO changes_jobs(id,due) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET due=excluded.due').run(ctx.now);ctx.changed('change-sync','status');options.onRefresh?.();return {message:'asked for a read'};}
 }));
 operations.register(operation({name:'changes.confirm',input:z.object({id:z.string(),head:z.string()}),output:z.object({open:z.boolean(),person:z.string().optional()}),
  may:(v,input)=>{const c=loadChanges(db).find(c=>c.id===input.id);return !!c&&mayAct(v,scope(c),sharing(),'household','changes.confirm');},
  run(ctx,input){const c=loadChanges(db).find(c=>c.id===input.id)!;const rule=c.agent?options.approvals?.rule(ctx.viewer,c.agent,targetOf(c)):undefined;return {open:!!rule&&c.head.id===input.head&&/^[0-9a-f]{40}$/.test(c.head.id)&&waitsOn(c,rule).group==='you',...(rule?.for?{person:rule.for.slug}:{})};}
 }));
 live.register({name:'change-sync',ids:()=>['status'],read(_id,v){if(!maySee(v,{type:'change'},sharing())) return;const row=db.prepare("SELECT value FROM changes_meta WHERE key='sync-status'").get() as {value:string}|undefined;return {id:'status',...(row?JSON.parse(row.value):{at:null,error:false}),available:!!row};},inScope:()=>true});
 operations.register(operation({name:'changes.answer',write:true,input:z.object({id:z.string(),head:z.string().regex(/^[0-9a-f]{40}$/),action:z.enum(['yes','not-yet','always']),person:z.string().optional()}),output:z.unknown(),
  may:(v,input)=>{const c=loadChanges(db).find(c=>c.id===input.id);return !!c&&mayAct(v,scope(c),sharing(),'household','changes.answer')&&mayAct(v,scope(c),sharing(),'answer-person','changes.answer');},
  run(ctx,input){
   const c=loadChanges(db).find(c=>c.id===input.id)!;
   if(c.head.id!==input.head) throw new OperationError('conflict','A new commit arrived; look again.');
   if(c.state!=='open'||!c.agent) throw new OperationError('invalid',"That is not an open agent's change.");
   if(!options.approvals) throw new OperationError('unavailable','Approvals is unavailable');
   const rule=options.approvals.rule(ctx.viewer,c.agent,targetOf(c));
   if(!rule) throw new OperationError('unavailable','Approvals could not confirm the current rule');
   if(waitsOn(c,rule).group!=='you') throw new OperationError('conflict','This change is not waiting on you');
   if((rule.for?.slug??'')!==(input.person??'')||rule.for&&(rule.for.state!=='pending'||input.action==='always')) throw new OperationError('conflict','That person is no longer waiting for an answer');
   if(input.action==='always'&&!c.project) throw new OperationError('invalid','No household project names this repository');
   const answer=options.approvals.answer(ctx.viewer,{agent:c.agent,target:targetOf(c),deny:input.action==='not-yet',...(input.person?{person:input.person}:{}),...(input.action==='always'?{alwaysProject:c.project}:{})},`changes:${randomUUID()}`);
   if(!answer.ok) throw new OperationError(answer.code,answer.message);
   ctx.changed('change',c.id);return answer.value;
  }
 }));
 live.register({name:'change',ids:()=>loadChanges(db).map(c=>c.id),read(id,v){const c=loadChanges(db).find(c=>c.id===id);return c&&see(v,c)?decorate(c,v):undefined;},inScope:(r,parent,now)=>(parent===undefined||r.project===parent)&&active(r as unknown as Change,now),expires:r=>r.state==='open'?undefined:Date.parse(String(r.closed))+week});
 live.observe(changes=>{if(changes.some(c=>c.type==='task'||c.type==='approval')) live.changed(loadChanges(db).map(c=>({type:'change',id:c.id})));});
 return { decorate };
}
