import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { migrate, operation, OperationError, mayUseThread, maySee, type Db, type Operations, type Live, type Sharing, type Viewer, type Clock, type LiveRecord } from '../../core/index.js';
import { schema } from './schema/001.js';
import { thread, saveThread, append, messageRows, messageId, type Thread, type MessageRow } from './store.js';
import type { WordsKey } from './crypto.js';
import { HeldEffect } from './role.js';
import type { Comms, AgentPost, StartNotice, RuntimeDelivery, Hold, Attention } from './role.js';
const day = 86400_000;
const workingStale = 90_000;
const fail = (code: 'denied'|'conflict'|'invalid'|'unavailable', message: string): never => { throw new OperationError(code,message); };
const text = z.string().min(1).max(40_000).refine(s => !!s.trim());
const title = z.string().min(1).max(60).refine(s => !!s.trim() && !/[\r\n]/.test(s));
const id = z.string().min(1).max(200);
const clientId = z.string().regex(/^[a-z2-7]{16}$/);
const target = z.object({ thread: id });
export interface Options {
 db: Db; operations: Operations; live: Live; clock: Clock; sharing(): Sharing; key: WordsKey;
 runtime: RuntimeDelivery; hold: Hold; attention: Attention; days?: number;
}
export function installComms(o: Options): Comms & { close(): Promise<void> } {
 const {db,operations,live,clock,key} = o;
 const days = o.days ?? 14;
 if (!Number.isInteger(days) || days < 1 || days > 14) throw new Error('Comms retention must be 1–14 days');
 migrate(db,'comms',schema); db.pragma('secure_delete = ON');
 const see = (v: Viewer,t: Thread|undefined) => !!t && mayUseThread(v,t,o.sharing());
 const writable = (v: Viewer,input: {thread:string}) => see(v,thread(db,input.thread));
 const touched = (t: Thread, seq?: number) => { armSweep(); live.changed([{type:'thread',id:t.id}, ...(seq === undefined ? [] : [{type:'message',id:messageId(t.id,seq)}])]); };
 const requireAgent = (agent: string, place: string) => { const t = thread(db,place); if (!t || t.agent !== agent) return fail('denied','Thread unavailable'); return t; };
 // Settlement is derived from durable routing progress: no async rewrite of private rows.
 const progressed=(t:Thread,seq:number)=>t.working||(t.startedThrough??0)>=seq||!!db.prepare(
  "SELECT 1 FROM comms_messages WHERE thread=? AND seq>? AND (kind IN ('card','reply') OR (kind='error' AND (id LIKE 'notice:no-reply:%' OR id LIKE 'noreply-%'))) LIMIT 1"
 ).get(t.id,seq);
 const settleStart=(r:MessageRow,decoded:LiveRecord):LiveRecord=>{
  const {retryStart:_,...record}=decoded;
  if(r.kind!=='error'||!/^start:[1-9][0-9]*$/.test(r.id))return record;
  const step=record.step as Record<string,unknown>|undefined,t=thread(db,r.thread);
  if(!t)return record;
  const seq=Number(r.id.slice(6));
  const source=db.prepare("SELECT * FROM comms_messages WHERE thread=? AND seq=? AND kind='message'").get(r.thread,seq) as MessageRow|undefined;
  const generation=source?JSON.parse(source.record).generation??0:undefined;
  if(step?.error==='start-failed'&&source?.words&&source.at+days*day>clock.now()&&t.archived===null&&
   !progressed(t,seq)&&generation===(step.generation??0))return {...record,retryStart:{seq,generation}};
  if(step?.error!=='start-retry'||!progressed(t,seq))return record;
  const name=t.agent.charAt(0).toUpperCase()+t.agent.slice(1);
  return {...record,text:`${name} couldn't start at first.`,step:{...step,settled:true}};
 };
 const progressChanged=(t:Thread)=>live.changed((db.prepare(
  "SELECT seq FROM comms_messages WHERE thread=? AND kind='error' AND id GLOB 'start:[0-9]*' AND words IS NOT NULL AND at>?"
 ).all(t.id,clock.now()-days*day) as {seq:number}[]).map(r=>({type:'message',id:messageId(t.id,r.seq)})));
 const decode = async (r: MessageRow): Promise<LiveRecord> => {
  const {encoding,stepCipher,privateCipher,legacyHash,...metadata}=JSON.parse(r.record);
  const alive=()=>r.words!==null && r.at + days*day > clock.now();
  if(!alive())return {id:messageId(r.thread,r.seq),thread:r.thread,seq:r.seq,at:r.at,kind:r.kind,from:r.sender,...metadata,text:null};
  const plain=await key.open(r.words!);
  const privateMetadata=privateCipher?JSON.parse(await key.open(Buffer.from(privateCipher,'base64'))):{};
  const step=stepCipher?JSON.parse(await key.open(Buffer.from(stepCipher,'base64'))):undefined;
  // Crypto can cross the retention deadline. Never return any private field after it.
  const words=encoding==='text'?{text:plain}:encoding==='ask'?{ask:JSON.parse(plain),text:null}:JSON.parse(plain);
  return settleStart(r,{id:messageId(r.thread,r.seq),thread:r.thread,seq:r.seq,at:r.at,kind:r.kind,from:r.sender,...metadata,...(alive()?{...privateMetadata,...words,...(step===undefined?{}:{step})}:{text:null})});
 };
 const retainedPage = (rows:MessageRow[],records:LiveRecord[]) => records.map((record,n)=>rows[n].at+days*day>clock.now()?settleStart(rows[n],record):{id:record.id,thread:rows[n].thread,seq:rows[n].seq,at:rows[n].at,kind:rows[n].kind,from:rows[n].sender,text:null});
 const sealedRecord = (r: MessageRow): LiveRecord => ({id:messageId(r.thread,r.seq),thread:r.thread,row:r});
 const bodyAlive = (t:Thread) => t.working && typeof t.aliveAt==='number' && t.aliveAt >= (t.workingSince??t.last)-60_000 && t.aliveAt <= clock.now()+60_000
  ? {at:t.aliveAt,...(typeof t.aliveTokens==='number'?{tokens:t.aliveTokens}:{})} : undefined;
 const visibleThread = (t: Thread) => {
  const reply = db.prepare("SELECT max(seq) AS seq FROM comms_messages WHERE thread=? AND kind='reply'").get(t.id) as {seq:number|null};
  const {firstHash, firstId, aliveAt, aliveTokens, ...record} = t;
  return {...record,...(bodyAlive(t)?{alive:bodyAlive(t)}:{}),unread:(reply.seq ?? 0)>t.readSeq};
 };
 live.register({name:'thread',windowOnly:true,
  ids:()=> (db.prepare('SELECT id FROM comms_threads').all() as {id:string}[]).map(r=>r.id),
  read:(id,v)=> { const t=thread(db,id); return t && see(v,t) ? visibleThread(t) : undefined; },
  inScope:(r,scope)=> scope === 'archived' ? r.archived !== null : r.archived === null,
 });
 live.register({name:'message',windowOnly:true,
  ids:scope=>scope ? messageRows(db,scope).map(r=>messageId(r.thread,r.seq)) : [],
  read:(id,v)=> { const cut=id.lastIndexOf('/'), place=id.slice(0,cut), seq=Number(id.slice(cut+1)); if(!see(v,thread(db,place))) return; const r=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(place,seq) as MessageRow|undefined; return r ? sealedRecord(r) : undefined; },
  resolve: r=>decode(r.row as MessageRow),
  inScope:(r,scope)=>r.thread===scope,
 });
 const output=z.unknown();
 const ack=z.object({thread:z.string(),seq:z.number().int().optional(),conversation:z.string().optional(),endGeneration:z.number().int().optional()});
 const hashText=(text:string)=>{const salt=db.prepare("SELECT value FROM comms_meta WHERE key='legacy-salt'").get() as {value:string}|undefined;return salt?createHmac('sha256',Buffer.from(salt.value,'base64')).update(`words\0${text}`).digest('hex'):key.hash(text);};
 const agentThreads = (member:string) => (db.prepare('SELECT record FROM comms_threads WHERE member=?').all(member) as {record:string}[])
  .map(r=>JSON.parse(r.record) as Thread).filter(t=>t.archived===null&&see({kind:'member',id:member},t)).sort((a,b)=>b.last-a.last||a.id.localeCompare(b.id));
 const agentSummaries = (member:string) => {
  const agents=[...(o.sharing().members[member]?.agents??[])];
  const threads=agentThreads(member);
  return {agents,threads,desks:agents.map(agent=> {
   const mine=threads.filter(t=>t.agent===agent);
   const unread=mine.map(t=>({t,row:db.prepare("SELECT * FROM comms_messages WHERE thread=? AND kind='reply' AND seq>? ORDER BY seq LIMIT 1").get(t.id,t.readSeq) as MessageRow|undefined})).filter(item=>item.row);
   return {agent,unread:unread.length,last:mine[0],first:unread[0]};
  })};
 };
 const firstLine = (value:string) => {
  const letters=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value.replace(/\s+/g,' ').trim())].map(g=>g.segment);
  return letters.length>160?`${letters.slice(0,159).join('').trimEnd()}…`:letters.join('');
 };
 operations.register(operation({name:'comms.agents',doors:['socket'],windowOnly:true,input:z.object({}),output,
  may:v=>v.kind==='member',
  prepare:async (_i,ctx)=> {
   const snapshot=agentSummaries(ctx.viewer.id);
   const records=await Promise.all(snapshot.desks.map(d=>d.first?.row?decode(d.first.row):undefined));
   return {snapshot,records};
  },
  run(ctx,_i,raw) {
   const {snapshot,records}=raw as {snapshot:ReturnType<typeof agentSummaries>;records:(LiveRecord|undefined)[]};
   if(JSON.stringify(agentSummaries(ctx.viewer.id))!==JSON.stringify(snapshot))return fail('conflict','Threads changed; load summaries again');
   return {member:ctx.viewer.id,agents:snapshot.agents,summaries:snapshot.desks.map((d,n)=>({agent:d.agent,unread:d.unread,
    ...(d.last?{last:{thread:d.last.id,title:d.last.title,at:d.last.last}}:{}),
    ...(d.first?.row?{first:{thread:d.first.t.id,text:d.first.row.at+days*day>clock.now()&&typeof records[n]?.text==='string'?firstLine(records[n]!.text as string):null}}:{}),
   }))};
  },
 }));
 let closed=false;
 const pending = new Map<string,Promise<void>>();
 type End = {thread:string;conversation:string;generation:number;action:'archive'|'delete'};
 const endKey=(place:string)=>`pending-end:${place}`;
 function queueEnd(t:Thread,action:End['action'],generation:number) {
  const value:End={thread:t.id,conversation:t.conversation,generation,action};
  db.prepare('INSERT INTO comms_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(endKey(t.id),JSON.stringify(value));
 }
 function end(place:string,generation:number):Promise<void> {
  if(closed)return Promise.resolve();
  const row=db.prepare('SELECT value FROM comms_meta WHERE key=?').get(endKey(place)) as {value:string}|undefined;
  if(!row)return Promise.resolve();
  const job=JSON.parse(row.value) as End;
  if(job.generation!==generation)return Promise.resolve();
  const marker=`comms-end:${place}:${generation}`,prior=pending.get(marker);if(prior)return prior;
  const task=o.hold(async()=>{
   if(closed)return;
   const saved=db.prepare('SELECT value FROM comms_meta WHERE key=?').get(endKey(place)) as {value:string}|undefined;
   if(saved?.value!==row.value)return;
   const current=thread(db,place);
   // Reopening cancels an archive; a later lifecycle replaces this journal entry.
   const eligible=job.action==='archive'
    ?current?.archived!==null&&current?.endGeneration===generation&&current.conversation===job.conversation
    :!current&&!!db.prepare('SELECT 1 FROM comms_deleted WHERE id=? AND conversation=?').get(place,job.conversation);
   if(eligible)await o.runtime.end(job.conversation);
   // Conditional deletion preserves a newer job committed while runtime awaited.
   db.prepare('DELETE FROM comms_meta WHERE key=? AND value=?').run(endKey(place),row.value);
  },{id:marker,kind:'body-start',title:'End a Comms body'}).catch(()=>{}).finally(()=>pending.delete(marker));
  pending.set(marker,task);return task;
 }
 async function reconcileEnds() {
  if(closed)return;
  const jobs=db.prepare("SELECT value FROM comms_meta WHERE key LIKE 'pending-end:%'").all() as {value:string}[];
  await Promise.all(jobs.map(row=>{const job=JSON.parse(row.value) as End;return end(job.thread,job.generation);}));
 }
 function deliver(agent:string,place:string,seq:number):Promise<void> {
  const marker=messageId(place,seq);const prior=pending.get(marker);if(prior)return prior;
  if(closed)return Promise.resolve();
  const task=performDelivery(agent,place,seq).finally(()=>pending.delete(marker));pending.set(marker,task);return task;
 }
 async function performDelivery(agent:string,place:string,seq:number) {
  let snapshot:MessageRow|undefined,runtimeEntered=false;
  try {
   const original=requireAgent(agent,place);
   const found=db.prepare("SELECT * FROM comms_messages WHERE thread=? AND seq=? AND kind='message'").get(place,seq) as MessageRow|undefined;
   if (!found) return;
   let row:MessageRow=found;
   if (JSON.parse(row.record).delivery==='delivered') return;
   snapshot=row;
   const checked=()=>{
    const t=requireAgent(agent,place);
    const current=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(place,seq);
    if(closed || t.member!==original.member || t.conversation!==original.conversation || t.project!==original.project ||
     JSON.stringify(current)!==JSON.stringify(row) || !row.words || row.at+days*day<=clock.now() || t.archived!==null ||
     !mayUseThread({kind:'member',id:original.member},t,o.sharing()))return fail('denied','Thread unavailable');
    return t;
   };
   checked();
   const state=JSON.parse(row.record);
   const attempt=state.generation?{generation:state.generation}:{};
   // Fresh persisted rows and staging refusals have not reached runtime. Every
   // other retry must fence prior acceptance while owning the same pending slot.
   if(state.delivery!=='held' && state.attempted!==false) {
    if(!o.runtime.receipt)return;
    let receipt:'accepted'|'not-accepted'|'unknown';
    try {receipt=await o.runtime.receipt({thread:place,agent,member:original.member,conversation:original.conversation,seq,...attempt,...(original.project?{project:original.project}:{})});}
    catch {return;}
    checked();
    if(receipt==='accepted'){settle(place,seq,'delivered',row);return;}
    if(receipt!=='not-accepted')return;
   }
   const plain=await key.open(row.words!);const words=JSON.parse(row.record).encoding==='text'?{text:plain}:JSON.parse(plain) as {text:string};
   // Bind decrypted words to their original routing and exact message, including
   // the receipt. A later replacement must never receive words or our settlement.
   checked();
   await o.hold(async()=> {
    const t=checked();
    // Commit uncertainty before the external call: a crash here must consult a
    // receipt, even when runtime accepted but its acknowledgement was lost.
    settle(place,seq,'sending',row,true);
    row=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(place,seq) as MessageRow;
    snapshot=row;
    runtimeEntered=true;
    await o.runtime.deliver({thread:place,agent,member:t.member,conversation:t.conversation,seq,...attempt,text:words.text,...(t.project?{project:t.project}:{})});
   },{id:`comms-deliver:${place}:${seq}${state.generation?`:g${state.generation}`:''}`,kind:'body-start',title:'Deliver a Comms message'});
   settle(place,seq,'delivered',row);
  } catch(error) { if(snapshot)settle(place,seq,error instanceof HeldEffect&&!runtimeEntered?'held':'failed',snapshot); }

 }
 let recovery:Promise<void>|undefined;
 function reconcileDeliveries():Promise<void> {
  if(recovery)return recovery;
  recovery=recoverDeliveries().finally(()=>{recovery=undefined;});return recovery;
 }
 async function recoverDeliveries() {
  if(closed)return;
  const rows=db.prepare("SELECT * FROM comms_messages WHERE kind='message' AND json_extract(record,'$.delivery') IN ('sending','held','failed') ORDER BY thread,seq").all() as MessageRow[];
  for(const row of rows) {
   if(closed)return;
   const t=thread(db,row.thread);
   if(!t)continue;
   // No words or crypto are needed to settle sends that can no longer run.
   if(!row.words||row.at+days*day<=clock.now()||t.archived!==null||!see({kind:'member',id:t.member},t)) {
    // An active delivery owns its receipt until it completes.
    if(!pending.has(messageId(row.thread,row.seq)))settle(row.thread,row.seq,'failed');
   } else await deliver(t.agent,t.id,row.seq);
  }
 }
 function settle(place:string,seq:number,delivery:string,expected?:MessageRow,attempted?:boolean) {
  if(closed)return;
  const t=thread(db,place); if(!t)return;
  const row=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(place,seq) as MessageRow|undefined;
  if(!row || expected && JSON.stringify(row)!==JSON.stringify(expected))return;
  db.prepare('UPDATE comms_messages SET record=? WHERE thread=? AND seq=?').run(JSON.stringify({...JSON.parse(row.record),delivery,...(attempted===undefined?{}:{attempted})}),place,seq);
  touched(t,seq);
 }
 function sendAfter(input:unknown,answer: {ok:true;value:unknown}|{ok:false}) {
  if(!answer.ok)return;
  armSweep();
  const value=answer.value as {thread:string;seq:number};
  const t=thread(db,value.thread); if(t)void deliver(t.agent,t.id,value.seq);
 }
 operations.register(operation({name:'comms.open',doors:['socket'],windowOnly:true,write:true,
  input:z.object({agent:id,id:clientId,text,project:id.optional()}),output:ack,
  may:(v,i)=>v.kind==='member' && mayUseThread(v,{member:v.id,agent:i.agent},o.sharing()) && (!i.project || maySee(v,{project:i.project},o.sharing()) && maySee({kind:'agent',id:i.agent},{project:i.project},o.sharing())),
  prepare:async i=>({words:await key.seal(JSON.stringify({text:i.text})),hash:hashText(i.text)}),
  run(ctx,i,raw) {
   const p=raw as {words:Buffer;hash:string};
   const existing=(db.prepare('SELECT record FROM comms_threads WHERE member=?').all(ctx.viewer.id) as {record:string}[]).map(r=>JSON.parse(r.record) as Thread).find(t=>t.firstId===i.id);
   if(existing) { if(existing.agent!==i.agent || existing.firstHash!==p.hash) return fail('conflict','Message id already used'); return {thread:existing.id,seq:1}; }
   const bytes=Buffer.from(hashText(`${ctx.viewer.id}\0${i.agent}\0${i.id}`),'hex');
   let bits=0,value=0,encoded='';for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){encoded+='abcdefghijklmnopqrstuvwxyz234567'[(value>>>(bits-5))&31];bits-=5;}}
   const place=`th:${encoded.slice(0,10)}`;
   if(db.prepare('SELECT 1 FROM comms_deleted WHERE id=?').get(place))return fail('conflict','This thread was deleted');
   const t:Thread={id:place,member:ctx.viewer.id,agent:i.agent,conversation:`cv-${createHash('sha256').update(`${i.agent}\0loom\0${place}`).digest('hex').slice(0,12)}`,project:i.project,title:null,titledBy:null,pinned:false,archived:null,opened:ctx.now,last:ctx.now,readSeq:0,nextSeq:1,stop:false,firstId:i.id,firstHash:p.hash,working:false};
   saveThread(db,t);
   const {seq}=append(db,t,{id:i.id,kind:'message',at:ctx.now,sender:t.member,words:p.words,hash:p.hash,record:JSON.stringify({delivery:'sending',attempted:false})});
   ctx.changed('thread',place);ctx.changed('message',messageId(place,seq));return {thread:place,seq};
  },after:(i,r)=>sendAfter(i,r),
 }));
 operations.register(operation({name:'comms.send',doors:['socket'],windowOnly:true,write:true,
  input:target.extend({id:clientId,text}),output:ack,may:(v,i)=>writable(v,i),
  prepare:async i=>({words:await key.seal(JSON.stringify({text:i.text})),hash:hashText(i.text)}),
  run(ctx,i,raw) {
   const t=thread(db,i.thread)!; if(t.archived!==null)return fail('conflict','Unarchive this thread first');
   const p=raw as {words:Buffer;hash:string};let value;
   try {value=append(db,t,{id:i.id,kind:'message',at:ctx.now,sender:t.member,words:p.words,hash:p.hash,record:JSON.stringify({delivery:'sending',attempted:false})});} catch {return fail('conflict','Message id already used');}
   ctx.changed('thread',t.id);ctx.changed('message',messageId(t.id,value.seq));return {thread:t.id,seq:value.seq};
  },after:(i,r)=>sendAfter(i,r),
 }));
 operations.register(operation({name:'comms.messages',doors:['socket'],windowOnly:true,
  input:target.extend({before:z.number().int().positive().optional()}),output,may:(v,i)=>writable(v,i),
  prepare:async i=> {const rows=messageRows(db,i.thread,i.before);return {rows,records:await Promise.all(rows.map(decode))};},
  run(ctx,i,raw) { const p=raw as {rows:MessageRow[];records:LiveRecord[]}; if(JSON.stringify(messageRows(db,i.thread,i.before))!==JSON.stringify(p.rows))return fail('conflict','Thread changed; load this page again');return retainedPage(p.rows,p.records); },
 }));
 const changeInput=target.extend({action:z.enum(['title','project','pin','unpin','archive','unarchive','read','stop','delete']),title:title.optional(),project:id.nullable().optional(),seq:z.number().int().nonnegative().optional()});
 operations.register(operation({name:'comms.change',doors:['socket'],windowOnly:true,write:true,input:changeInput,output:ack,may:(v,i)=>writable(v,i),
  run(ctx,i) {
   const t=thread(db,i.thread)!;
   switch(i.action) {
    case 'title': if(i.title===undefined)return fail('invalid','A title is required');t.title=i.title;t.titledBy='member';break;
    case 'project': {
     if(i.project && (!maySee(ctx.viewer,{project:i.project},o.sharing()) || !maySee({kind:'agent',id:t.agent},{project:i.project},o.sharing())))return fail('invalid','Choose a project of this agent');
     t.project=i.project ?? undefined;break;
    }
    case 'pin': {
     const pins=(db.prepare('SELECT record FROM comms_threads WHERE member=?').all(t.member) as {record:string}[]).filter(r=>JSON.parse(r.record).pinned).length;
     if(!t.pinned && pins>=8)return fail('conflict','At most eight pinned threads');t.pinned=true;break;
    }
    case 'unpin':t.pinned=false;break;
    case 'archive':if(t.archived===null){t.endGeneration=(t.endGeneration??0)+1;t.archived=ctx.now;t.working=false;t.workingSince=null;t.workingBeat=null;queueEnd(t,'archive',t.endGeneration);}break;
    case 'unarchive':t.archived=null;db.prepare('DELETE FROM comms_meta WHERE key=?').run(endKey(t.id));break;
    case 'read': if(i.seq===undefined)return fail('invalid','A message number is required'); t.readSeq=Math.max(t.readSeq,Math.min(i.seq,t.nextSeq-1));break;
    case 'stop':t.stop=true;break;
    case 'delete':
     queueEnd(t,'delete',(t.endGeneration??0)+1);
     db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run(t.id,t.member,t.agent,t.conversation,ctx.now);
     for(const r of messageRows(db,t.id,undefined,2147483647))ctx.changed('message',messageId(t.id,r.seq));
     db.prepare('DELETE FROM comms_threads WHERE id=?').run(t.id);ctx.changed('thread',t.id);return {thread:t.id,conversation:t.conversation,endGeneration:(t.endGeneration??0)+1};
   }
   saveThread(db,t);ctx.changed('thread',t.id);return {thread:t.id,conversation:t.conversation,endGeneration:t.endGeneration??0};
  },
  after(i,result) {
   if((i.action!=='archive'&&i.action!=='delete')||!result.ok||closed)return;
   const value=result.value as {endGeneration:number};
   void end(i.thread,value.endGeneration);
  },
 }));
 operations.register(operation({name:'comms.resend',doors:['socket'],windowOnly:true,write:true,input:target.extend({seq:z.number().int().positive()}),output:ack,may:(v,i)=>writable(v,i),
  run(ctx,i) {const t=thread(db,i.thread)!;const row=db.prepare("SELECT * FROM comms_messages WHERE thread=? AND seq=? AND kind='message'").get(t.id,i.seq) as MessageRow|undefined;
   if(t.archived!==null)return fail('conflict','Unarchive this thread first');
   if(!row?.words)return fail('conflict','Message words are no longer kept');
   return {thread:t.id,seq:i.seq};},
  // A failed/sending receipt is uncertain even when a person asks again.
  // Only an authoritative runtime fence may authorize another delivery.
  after:(_i,r)=>{if(r.ok&&!closed)void reconcileDeliveries();},
 }));
 operations.register(operation({name:'comms.retryStart',doors:['socket'],windowOnly:true,write:true,
  input:target.extend({seq:z.number().int().positive(),generation:z.number().int().min(0).max(999)}),output:ack,may:(v,i)=>writable(v,i),
  prepare:async(i)=>{
   const source=db.prepare("SELECT * FROM comms_messages WHERE thread=? AND seq=? AND kind='message'").get(i.thread,i.seq) as MessageRow|undefined;
   const notice=db.prepare("SELECT * FROM comms_messages WHERE thread=? AND kind='error' AND id=?").get(i.thread,`start:${i.seq}`) as MessageRow|undefined;
   if(!source?.words||!notice?.words)return fail('conflict','Start failure unavailable');
   const original=thread(db,i.thread)!;
   const payload=JSON.parse(await key.open(notice.words));
   return {source,notice,original,payload};
  },
  run(ctx,i,raw){
   const {source,notice,original,payload}=raw as {source:MessageRow;notice:MessageRow;original:Thread;payload:{step?:{error?:string;generation?:number}}};
   const t=thread(db,i.thread)!;
   const current=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(i.thread,i.seq);
   const currentNotice=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(i.thread,notice.seq);
   if(closed||t.archived!==null||t.member!==original.member||t.conversation!==original.conversation||t.project!==original.project||
    JSON.stringify(current)!==JSON.stringify(source)||JSON.stringify(currentNotice)!==JSON.stringify(notice)||
    source.at+days*day<=ctx.now||notice.at+days*day<=ctx.now||progressed(t,i.seq)||pending.has(messageId(i.thread,i.seq))||
    (JSON.parse(source.record).generation??0)!==i.generation||payload.step?.error!=='start-failed'||(payload.step.generation??0)!==i.generation)
    return fail('conflict','Start failure changed; load the thread again');
   // Only an authoritative final-start failure authorizes a NEW generation. Lost
   // acceptance for that generation still uses the ordinary receipt fence.
   db.prepare('UPDATE comms_messages SET record=? WHERE thread=? AND seq=?').run(
    JSON.stringify({...JSON.parse(source.record),generation:i.generation+1,delivery:'sending',attempted:false}),i.thread,i.seq);
   ctx.changed('message',messageId(i.thread,i.seq));ctx.changed('message',messageId(i.thread,notice.seq));
   return {thread:i.thread,seq:i.seq};
  },after:(i,r)=>sendAfter(i,r),
 }));
 operations.register(operation({name:'comms.answer',doors:['socket'],windowOnly:true,write:true,input:target.extend({ref:id,verdict:z.enum(['yes','no']),words:z.string().max(4000).optional()}),output:ack,may:(v,i)=>writable(v,i),
  prepare:async (i,ctx)=>{
   const original=thread(db,i.thread);
   const ask=db.prepare("SELECT * FROM comms_messages WHERE thread=? AND kind='ask' AND (id=? OR json_extract(record,'$.ref')=?) AND words IS NOT NULL AND at > ?").get(i.thread,i.ref,i.ref,clock.now()-days*day) as MessageRow|undefined;
   if(closed||!original||!see(ctx.viewer,original)||!ask)return fail('denied','Ask unavailable');
   const words=await key.seal(JSON.stringify({text:i.words ?? '',ref:i.ref,verdict:i.verdict}));
   return {original,ask,words};
  },
  run(ctx,i,raw) {
   const {original,ask,words}=raw as {original:Thread;ask:MessageRow;words:Buffer};
   const t=thread(db,i.thread)!;
   const current=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(i.thread,ask.seq);
   // Permission alone cannot bind an answer to the question and routing the
   // member saw: another owned agent or replacement ask could still pass it.
   if(closed||t.member!==original.member||t.agent!==original.agent||t.conversation!==original.conversation||t.project!==original.project||
    JSON.stringify(current)!==JSON.stringify(ask)||ask.at+days*day<=clock.now())return fail('denied','Ask unavailable');
   if(i.words)return fail('unavailable','Private word answers need the private attention role');
   // Attention is an in-process role, so its policy and answer participate in this transaction.
   const answered=o.attention.answer(ctx.viewer,{id:i.ref,answer:i.words?{kind:'words',text:i.words}:{kind:i.verdict}},`comms-answer:${key.hash(JSON.stringify(i))}`);
   if(!answered.ok)return fail(answered.code==='denied'?'denied':'conflict',answered.message);
   const result=append(db,t,{id:`answer:${i.ref}`,kind:'answer',at:ctx.now,sender:t.member,words,hash:key.hash(JSON.stringify(i)),record:'{}'});
   ctx.changed('message',messageId(t.id,result.seq));return {thread:t.id,seq:result.seq};
  },
 }));
 async function post(agent:string,place:string,raw:AgentPost,terminal=false) {
  const m=z.object({id,kind:z.enum(['reply','card','ask','error']),text,run:id.optional(),tool:z.string().max(100).optional(),state:z.enum(['running','done','failed']).optional(),ref:id.optional(),step:z.record(z.string(),z.unknown()).optional()}).parse(raw);
  const available=()=>{
   const t=requireAgent(agent,place);
   if(closed||!see({kind:'member',id:t.member},t))return fail('denied','Thread unavailable');
   if(t.archived!==null)return fail('conflict','Thread archived');
   return t;
  };
  const before=available();
  const words=await key.seal(JSON.stringify({text:m.text,run:m.run,tool:m.tool,state:m.state,step:m.step,ref:m.kind==='ask'?(m.ref??m.id):m.ref}));
  const result=db.transaction(()=> {
   const t=available();
   if(t.member!==before.member||t.conversation!==before.conversation||t.project!==before.project)return fail('denied','Thread unavailable');
   const meta=m.kind==='ask'?{ref:m.ref??m.id}:{};
   const old=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND kind=? AND id=?').get(place,m.kind,m.id) as MessageRow|undefined;
   if(old && m.kind==='card') {
    if(!old.words)return {seq:old.seq}; // A swept step cannot resurrect its words.
    db.prepare('UPDATE comms_messages SET words=?,record=? WHERE thread=? AND seq=?').run(words,JSON.stringify(meta),place,old.seq);return {seq:old.seq};
   }
   let result;try{result=append(db,t,{id:m.id,kind:m.kind,at:clock.now(),sender:agent,words,hash:key.hash(JSON.stringify(m)),record:JSON.stringify(meta)});}catch{return fail('conflict','Reply id already used');}
   // Only the first notice settles a turn; a replay must not stop a later body.
   if(terminal&&!result.repeat){t.working=false;t.workingSince=null;t.workingBeat=null;saveThread(db,t);}
   return {seq:result.seq};
  })();
  const current=requireAgent(agent,place);
  touched(current,result.seq);
  if(m.kind==='card'||m.kind==='reply'||m.id.startsWith('notice:no-reply:'))progressChanged(current);
  return result;
 }
 async function startNotice(agent:string,place:string,raw:StartNotice) {
  const common={generation:z.number().int().min(0).max(1000).optional(),seq:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),attempt:z.number().int().min(1).max(1000),
   reason:z.string().min(1).max(200).refine(s=>!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s)).optional(),
   run:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional()};
  const n=z.discriminatedUnion('kind',[
   z.object({...common,kind:z.literal('start-retry'),retryAt:z.iso.datetime({offset:true})}).strict(),
   z.object({...common,kind:z.literal('start-failed')}).strict(),
  ]).parse(raw);
  const available=()=>{
   const t=requireAgent(agent,place);
   if(closed||t.archived!==null||!see({kind:'member',id:t.member},t))return fail('denied','Thread unavailable');
   return t;
  };
  const before=available();
  const source=db.prepare("SELECT * FROM comms_messages WHERE thread=? AND seq=? AND kind='message' AND sender=?").get(place,n.seq,before.member) as MessageRow|undefined;
  if(!source||!source.words||source.at+days*day<=clock.now())return fail('unavailable','Message unavailable');
  const generation=JSON.parse(source.record).generation??0;
  if((n.generation??0)!==generation)return {seq:null};
  const noticeId=`start:${n.seq}`;
  const readNotice=()=>db.prepare("SELECT * FROM comms_messages WHERE thread=? AND kind='error' AND id=?").get(place,noticeId) as MessageRow|undefined;
  const old=readNotice();
  const recheck=()=>{
   const t=available();
   const currentSource=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(place,n.seq);
   if(t.member!==before.member||t.conversation!==before.conversation||t.project!==before.project||
    JSON.stringify(currentSource)!==JSON.stringify(source)||source.at+days*day<=clock.now())return fail('denied','Message unavailable');
   if(JSON.stringify(readNotice())!==JSON.stringify(old))return fail('conflict','Start notice changed');
   return t;
  };
  if(progressed(before,n.seq))return {seq:old?.seq??null};
  if(old&&(!old.words||old.at+days*day<=clock.now()))return {seq:old.seq};
  // Attempt, error reason and run stay inside ciphertext, including retry arbitration.
  const previous=old?JSON.parse(await key.open(old.words!)):undefined;
  if(progressed(recheck(),n.seq))return {seq:old?.seq??null};
  if(previous&&(previous.step?.generation??0)===generation&&(previous.step?.error!=='start-retry'||n.attempt<previous.step.attempt||
   (n.attempt===previous.step.attempt&&n.kind==='start-retry')))return {seq:old!.seq};
  const name=agent.charAt(0).toUpperCase()+agent.slice(1);
  const payload={text:n.kind==='start-retry'
   ? n.attempt===1?`${name} couldn't start; retrying.`:`${name} couldn't start (${n.attempt} tries so far); retrying.`
   : n.attempt===1?`${name} couldn't start.`:`${name} couldn't start after ${n.attempt} tries.`,
   run:n.run??previous?.run,step:{error:n.kind,attempt:n.attempt,...(generation?{generation}:{}),
    ...(n.kind==='start-retry'?{retry_at:new Date(n.retryAt).toISOString()}:{}),
    ...(n.reason??previous?.step?.reason?{reason:n.reason??previous.step.reason}:{})}};
  const encoded=JSON.stringify(payload),words=await key.seal(encoded);
  const result=db.transaction(()=>{
   const t=recheck();
   if(progressed(t,n.seq))return {seq:old?.seq??null};
   if(old) {
    if(old.at+days*day<=clock.now())return {seq:old.seq};
    db.prepare('UPDATE comms_messages SET words=?,hash=? WHERE thread=? AND seq=?').run(words,key.hash(encoded),place,old.seq);
    t.last=clock.now();saveThread(db,t);return {seq:old.seq};
   }
   return {seq:append(db,t,{id:noticeId,kind:'error',at:clock.now(),sender:agent,words,hash:key.hash(encoded),record:'{}'}).seq};
  })();
  if(result.seq!==null)touched(requireAgent(agent,place),result.seq);
  return result;
 }
 let cancel:()=>void=()=>{};
 function workingThreads(): Thread[] {
  return (db.prepare("SELECT record FROM comms_threads WHERE json_extract(record,'$.working')=1").all() as {record:string}[]).map(r=>JSON.parse(r.record) as Thread);
 }
 const workingDeadline=(t:Thread)=>(t.workingBeat??t.workingSince??t.last)+workingStale;
 function sweep() {
  if(closed)return;
  const stale=workingThreads().filter(t=>workingDeadline(t)<=clock.now());
  db.transaction(()=>{for(const t of stale){t.working=false;t.workingSince=null;t.workingBeat=null;saveThread(db,t);}})();
  live.changed(stale.map(t=>({type:'thread',id:t.id})));
  const rows=db.prepare('SELECT thread,seq FROM comms_messages WHERE words IS NOT NULL AND at <= ?').all(clock.now()-days*day) as {thread:string;seq:number}[];
  db.prepare("UPDATE comms_messages SET words=NULL, record=json_remove(record,'$.stepCipher','$.privateCipher') WHERE at <= ?").run(clock.now()-days*day);
  live.changed(rows.map(r=>({type:'message',id:messageId(r.thread,r.seq)})));
  armSweep();
 }
 function armSweep() {
  cancel();
  const next=db.prepare('SELECT min(at) AS at FROM comms_messages WHERE words IS NOT NULL').get() as {at:number|null};
  cancel=clock.at(Math.min(clock.now()+3600_000,next.at===null?Infinity:next.at+days*day,workingThreads().reduce((at,t)=>Math.min(at,workingDeadline(t)),Infinity)),sweep);
 }
 sweep();
 void reconcileEnds();
 void reconcileDeliveries();
 return {post,startNotice,deliver,reconcileEnds,reconcileDeliveries,
  notice(agent,place,raw) {
   const n=z.object({kind:z.enum(['no-reply','loop']),id:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)}).strict().parse(raw);
   const name=agent.charAt(0).toUpperCase()+agent.slice(1);
   return post(agent,place,{id:`notice:${n.kind}:${n.id}`,kind:'error',run:n.id,
    text:n.kind==='no-reply'?`${name} finished without replying.`:`Paused: ${name} was repeating itself.`,step:{error:n.kind}},true);
  },
  describe(agent,place) {
   const t=requireAgent(agent,place);
   if(closed||t.archived!==null||!see({kind:'member',id:t.member},t))return fail('denied','Thread unavailable');
   const name=t.member.charAt(0).toUpperCase()+t.member.slice(1);
   const brief=[
    `A private thread in loom's app with your owner, ${name}. Only they read it. They can see your tool use as you work. Work you record here can name this conversation as its source: conversation:${t.conversation}.`,
    `When you need ${name}'s OK, ask it as you always do (a needs_owner, or an approval request): it shows right here in the thread as a card with its buttons, as well as in their Inbox, and their answer comes back to you.`,
   ];
   const last=[t.project?`The thread is filed under the project ${t.project}.`:'',t.title?'':"Give the thread a short title once you know what it's about: call comms_title."].filter(Boolean).join(' ');
   if(last)brief.push(last);
   // Refuse malformed/imported routing facts rather than truncate a source identity.
   if(brief.some(line=>line.length>300||/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line)))return fail('unavailable','Thread description unavailable');
   return {brief,readers:[t.member]};
  },
  trace(agent,place) {
   const t=requireAgent(agent,place);
   const messages=messageRows(db,place,undefined,100).map(r=>{
    const delivery=JSON.parse(r.record).delivery;
    return {seq:r.seq,at:r.at,kind:r.kind,from:r.sender,
     ...(r.kind==='message'&&['sending','held','failed','delivered'].includes(delivery)?{delivery}:{}),
    };
   });
   return {thread:t.id,conversation:t.conversation,archived:t.archived,working:t.working,...(bodyAlive(t)?{alive:bodyAlive(t)}:{}),messages};
  },
  reader(binding) {
   // Snapshot trusted routing facts so later caller mutation cannot widen this capability.
   const {agent,conversation,valid}=binding;
   const allowed=binding.houseConversations===undefined?undefined:[...binding.houseConversations];
   return {async read(input={}) {
    const parsed=z.object({thread:id.optional(),before:z.number().int().positive().optional(),limit:z.number().int().positive().optional()}).parse(input);
    const lookup=()=>parsed.thread?thread(db,parsed.thread):(db.prepare('SELECT record FROM comms_threads WHERE agent=?').all(agent) as {record:string}[]).map(r=>JSON.parse(r.record) as Thread).find(t=>conversation!==undefined&&t.conversation===conversation);
    const permitted=(t:Thread|undefined):t is Thread=>!closed&&valid()&&!!t&&t.agent===agent&&(allowed===undefined||allowed.includes(t.conversation))&&mayUseThread({kind:'member',id:t.member},t,o.sharing());
    const t=lookup();if(!permitted(t))return fail('denied','Thread unavailable');
    const limit=Math.min(parsed.limit??30,100);
    const rows=messageRows(db,t.id,parsed.before,limit);
    const records=await Promise.all(rows.map(decode));
    const current=lookup();
    if(!permitted(current)||current.id!==t.id||current.member!==t.member||current.conversation!==t.conversation)return fail('denied','Thread unavailable');
    if(JSON.stringify(messageRows(db,t.id,parsed.before,limit))!==JSON.stringify(rows))return fail('conflict','Thread changed; load this page again');
    // An earlier row may expire while a later row is still decrypting.
    const messages=retainedPage(rows,records);
    return {thread:{id:current.id,title:current.title,archived:current.archived,working:current.working},messages};
   }};
  },
  title(agent,place,value) {title.parse(value); const t=requireAgent(agent,place);if(closed||t.archived!==null||!see({kind:'member',id:t.member},t))return fail('denied','Thread unavailable');if(t.titledBy==='member')return fail('conflict','The member named this thread');t.title=value;t.titledBy='agent';saveThread(db,t);touched(t);},
  activity(agent,place,alive) {
   const value=z.object({at:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),tokens:z.number().int().min(0).max(1e12).optional()}).strict().parse(alive);
   const t=requireAgent(agent,place);
   if(closed||t.archived!==null||!see({kind:'member',id:t.member},t))return fail('denied','Thread unavailable');
   if(value.at>clock.now()+60_000||value.at<=(t.aliveAt??-1))return;
   t.aliveAt=value.at;t.aliveTokens=value.tokens??null;
   saveThread(db,t);touched(t);
  },
  status(agent,place,state) {
   if(state!==undefined)z.enum(['working','done']).parse(state);
   const t=requireAgent(agent,place);
   if(closed||!see({kind:'member',id:t.member},t))return fail('denied','Thread unavailable');
   const stop=t.stop;t.stop=false;
   if(state!==undefined) {
    const working=state==='working'&&t.archived===null;
    t.workingSince=working?(t.working?t.workingSince??clock.now():clock.now()):null;
    t.workingBeat=working?clock.now():null;t.working=working;
    if(t.archived===null)t.startedThrough=t.nextSeq-1;
   }
   saveThread(db,t);touched(t);if(state!==undefined&&t.archived===null)progressChanged(t);return {stop,archived:t.archived!==null};
  },
  async close(){closed=true;cancel();await Promise.all([...pending.values(),...(recovery?[recovery]:[])]);},
 };
}
