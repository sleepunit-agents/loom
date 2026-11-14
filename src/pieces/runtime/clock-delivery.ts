/** Clock's owning handoff. Only ids cross the service operation; never a saved Viewer. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { operation, OperationError, mayAct, mayCreate, type Sharing, type Viewer } from '../../core/index.js';
import { isClosing, type Foundation } from '../../core/app.js';
import type { OutsideEffects } from '../../core/effects.js';
import { clockDispatchSource, clockRoute } from '../clock/role.js';
import { clockDestination } from './clock-destination.js';
import { enqueueBody } from './queue.js';
import { runtimeStore } from './store.js';
import { provenanceStore } from './provenance-store.js';
import { principalFromHistory } from './provenance.js';
import { currentExecution } from './control.js';
import { bodyPolicyExecutionHeld } from './policy-store.js';
import type { Wake } from '../clock/store.js';
import type { RuntimeRecords } from './records.js';
import type { ClockProvenanceReader } from './role.js';
export const CLOCK_BRIEF='Read scheduled inputs through runtime.readConversation. After reading, acknowledge through the last seq with runtime.acknowledgeClockInput. New inputs may arrive in this conversation.';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,40);
const id=z.string().min(1).max(200);
interface Turn {seq:number;id:string;conversation:string;job:string;record:string;released:number|null;consumed:number|null}
const sourceRecord=(wake:Wake,attempt:string)=>JSON.stringify({text:wake.prompt,project:wake.project,agent:wake.agent,service:wake.authorship?.service,authorship:wake.authorship,by:wake.by,attempt});
interface Proof {agent:string;job?:string;service?:string;valid():boolean}
export function clockDelivery(app:Foundation,sharing:()=>Sharing,effects:OutsideEffects,proof:(v:Viewer)=>Proof|undefined) {
  const {db,operations}=app,store=runtimeStore(db),destination=clockDestination(app,sharing);
  const owners=()=>Object.entries(sharing().members).filter(([,m])=>m.owner).map(([id])=>id);
  const currentSource=(row:Turn,job:RuntimeRecords['job'])=>{
    const record=JSON.parse(row.record) as {text:string;attempt:string};
    const source=clockDispatchSource(operations,row.id.slice('clock:'.length),record.attempt,true);
    return !!source && sourceRecord(source,record.attempt)===row.record && source.agent===job.agent
      && source.member===job.member && source.project===job.project && source.authorship?.service===job.service;
  };
  const valid=(jobId:string)=>{
    const job=store.read('job',jobId),binding=job?.conversation?store.read('binding',job.conversation):undefined;
    const root=job?.conversation?db.prepare('SELECT * FROM runtime_clock_turns WHERE conversation=? ORDER BY seq LIMIT 1').get(job.conversation) as Turn|undefined:undefined;
    return !!root&&!!job&&currentSource(root,job)
      &&!isClosing(app)&&!job.member&&!job.imported&&!job.principalReset&&!job.writtenOff
      &&job.endedAt===undefined&&!bodyPolicyExecutionHeld(db,job.agent)&&!!binding&&binding.venue==='wake'
      &&binding.job===job.id&&binding.agent===job.agent&&binding.member===job.member&&binding.project===job.project
      &&provenanceStore(db).read(binding.id)?.agent===job.agent&&currentExecution(store,job,sharing())
      &&mayCreate({kind:'agent',id:job.agent},{type:'wake',agent:job.agent,project:job.project},sharing());
  };
  const bound=(v:Viewer)=>{
    const p=proof(v);if(v.kind!=='agent'||!p||!p.valid()||p.agent!==v.id||!p.job||!valid(p.job))return;
    const job=store.read('job',p.job)!;
    return job.agent===v.id&&job.service===p.service&&['running','waiting'].includes(job.state)?job:undefined;
  };
  const source=(wake:string,attempt:string)=>{
    const w=clockDispatchSource(operations,wake,attempt);
    if(!w||w.member||!w.prompt||w.file||w.laneVersion||w.continuation||w.slot||w.approval||w.prompt.includes('<!-- house: local -->'))return;
    if(bodyPolicyExecutionHeld(db,w.agent))return;
    return w;
  };
  operations.register(operation({name:'runtime.acceptClock',doors:['direct'],write:true,recheckPolicy:true,
    input:z.object({wake:id,attempt:id}).strict(),output:z.object({job:id,source:id,joined:z.boolean()}),
    may:(v,i)=>v.kind==='service'&&v.id==='clock'&&!!source(i.wake,i.attempt)
      &&mayAct(v,{type:'runtime.job'},sharing(),'act','runtime.acceptClock'),
    run(ctx,i){
      const w=source(i.wake,i.attempt);if(!w)throw new OperationError('denied','Clock source ended');
      const key=`clock:${w.id}`,old=db.prepare('SELECT * FROM runtime_clock_turns WHERE id=?').get(key) as Turn|undefined;
      if(old){
        if(old.record!==sourceRecord(w,i.attempt))throw new OperationError('conflict','Wake source changed');
        return {job:old.job,source:key,joined:old.conversation!==`clock-${hash(w.id)}`};
      }
      const route=clockRoute(w,destination);
      let job:string,conversation:string;
      if(route.kind==='join'){
        if(!route.destination.current())throw new OperationError('denied','Clock destination changed');
        conversation=route.destination.conversation;
        const binding=store.read('binding',conversation)!;
        if(!binding.job||!valid(binding.job))throw new OperationError('denied','Clock destination ended');
        job=binding.job;
      }else{
        job=`clock-job-${hash(w.id)}`;conversation=`clock-${hash(w.id)}`;
        if(store.read('job',job)||store.read('binding',conversation))throw new OperationError('conflict','Clock start already exists');
        // Only a vacant lane is claimed. A mismatched active conversation is never replaced.
        const name=w.schedule,place=w.place??(name?`lane:${name}`.slice(0,200):undefined);
        const occupied=place&&store.ids('binding').some(id=>{const b=store.read('binding',id)!;return b.agent===w.agent&&b.venue==='wake'&&b.place===place;});
        store.put('binding',{id:conversation,agent:w.agent,project:w.project,venue:'wake',place:place?.startsWith('lane:')&&!occupied?place:route.place,job},ctx.now);
        enqueueBody(ctx,sharing(),{id:job,agent:w.agent,project:w.project,title:'Scheduled work',conversation,
          service:w.authorship?.service,model:w.model},{brief:CLOCK_BRIEF});
      }
      db.prepare('INSERT INTO runtime_clock_turns(id,conversation,job,record) VALUES (?,?,?,?)').run(key,conversation,job,
        sourceRecord(w,i.attempt));
      const principal=w.authorship?.principal;
      // Retain every named steering source; unknown stays unknown even if people are named.
      const provenance=provenanceStore(db);
      provenance.note(conversation,w.agent,{key,sender:{kind:'schedule',for:principal?.for},at:w.createdAt},owners());
      for(const person of principal?.people??[])provenance.note(conversation,w.agent,{key:`${key}:person:${person}`,sender:{kind:'person',person},at:w.createdAt},owners());
      ctx.changed('runtime.binding',conversation);
      return {job,source:key,joined:route.kind==='join'};
    },
  }));
  const read=(v:Viewer,before?:number)=>{
    const job=bound(v);if(!job)throw new OperationError('denied','Clock body binding ended');
    const rows=db.prepare('SELECT * FROM runtime_clock_turns WHERE conversation=? AND seq<? ORDER BY seq DESC LIMIT 100').all(job.conversation,before??Number.MAX_SAFE_INTEGER) as Turn[];
    const currentSources=()=>rows.every(row=>currentSource(row,job));
    if(!currentSources())throw new OperationError('denied','Clock delivery authority ended');
    // Central staging hold runs at the words boundary, including later joined turns.
    if(rows.some(r=>r.released===null)&&!effects.beforeOutside({id:`runtime:clock-read:${job.id}:${rows[0]?.seq}`,kind:'body-start',title:'Release scheduled conversation input'}))
      throw new OperationError('conflict','Scheduled input is held');
    // Recheck after the outside gate, before releasing any words or marking delivery.
    if(bound(v)?.id!==job.id||!currentSources())throw new OperationError('denied','Clock body binding ended');
    db.transaction(()=>{
      for(const row of rows){db.prepare('UPDATE runtime_clock_turns SET released=COALESCE(released,?) WHERE id=?').run(operations.clock.now(),row.id);}
    })();
    if(rows.some(r=>r.released===null))effects.finish(`runtime:clock-read:${job.id}:${rows[0]?.seq}`);
    app.live.changed([{type:'runtime.job',id:job.id}]);
    return {conversation:job.conversation,messages:rows.reverse().map(r=>({seq:r.seq,id:r.id,kind:'wake',text:(JSON.parse(r.record) as {text:string}).text}))};
  };
  operations.register(operation({name:'runtime.acknowledgeClockInput',doors:['http','direct'],write:true,recheckPolicy:true,
    input:z.object({through:z.number().int().positive()}).strict(),output:z.object({acknowledged:z.literal(true)}),
    may:v=>!!bound(v),run(ctx,i){
      const job=bound(ctx.viewer);if(!job)throw new OperationError('denied','Clock body binding ended');
      const rows=db.prepare('SELECT * FROM runtime_clock_turns WHERE conversation=? AND seq<=?').all(job.conversation,i.through) as Turn[];
      if(!rows.every(row=>currentSource(row,job)))throw new OperationError('denied','Clock delivery authority ended');
      if(!rows.some(row=>row.seq===i.through)||rows.some(row=>row.released===null))throw new OperationError('conflict','Input has not been released to this body');
      for(const row of rows)db.prepare('UPDATE runtime_clock_turns SET consumed=COALESCE(consumed,?) WHERE id=?').run(ctx.now,row.id);
      const keys=provenanceStore(db).read(job.conversation!)?.queue.map(row=>row.key)??[];
      provenanceStore(db).consumed(job.conversation!,keys.filter(key=>rows.some(row=>key===row.id||key.startsWith(`${row.id}:person:`))));
      ctx.changed('runtime.job',job.id);
      return {acknowledged:true as const};
    },
  }));
  const clockProvenance:ClockProvenanceReader=v=>{
    const job=bound(v);if(!job?.conversation)return;
    const p=provenanceStore(db).read(job.conversation);if(!p)return;
    return {agent:job.agent,conversation:job.conversation,project:job.project,service:job.service,principal:principalFromHistory(p.history,owners())};
  };
  return {valid,bound,read,clockProvenance,
    job:(wake:string)=>(db.prepare('SELECT job FROM runtime_clock_turns WHERE id=?').get(`clock:${wake}`) as {job:string}|undefined)?.job,
    consumed:(source:string)=>{const row=db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(source) as {consumed:number|null}|undefined;return !!row&&row.consumed!==null;},
  };
}
export type ClockBodies=ReturnType<typeof clockDelivery>;
