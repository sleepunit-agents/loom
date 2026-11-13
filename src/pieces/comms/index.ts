import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { migrate, operation, OperationError, mayUseThread, maySee, type Db, type Operations, type Live, type Sharing, type Viewer, type Clock, type LiveRecord } from '../../core/index.js';
import { schema } from './schema/001.js';
import { thread, saveThread, append, messageRows, messageId, type Thread, type MessageRow } from './store.js';
import type { WordsKey } from './crypto.js';
import type { Comms, AgentPost, RuntimeDelivery, Hold, Attention } from './role.js';
const day = 86400_000;
const fail = (code: 'denied'|'conflict'|'invalid'|'unavailable', message: string): never => { throw new OperationError(code,message); };
const text = z.string().min(1).max(40_000).refine(s => !!s.trim());
const title = z.string().min(1).max(60).refine(s => !!s.trim() && !/[\r\n]/.test(s));
const id = z.string().min(1).max(200);
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
 const touched = (t: Thread, seq?: number) => { live.changed([{type:'thread',id:t.id}, ...(seq === undefined ? [] : [{type:'message',id:messageId(t.id,seq)}])]); };
 const requireAgent = (agent: string, place: string) => { const t = thread(db,place); if (!t || t.agent !== agent) return fail('denied','Thread unavailable'); return t; };
 const decode = async (r: MessageRow): Promise<LiveRecord> => {
  const {encoding,stepCipher,legacyHash,...metadata}=JSON.parse(r.record);
  const plain=r.words ? await key.open(r.words) : null;
  const words=plain===null?{text:null}:encoding==='text'?{text:plain}:encoding==='ask'?{ask:JSON.parse(plain),text:null}:JSON.parse(plain);
  return {id:messageId(r.thread,r.seq),thread:r.thread,seq:r.seq,at:r.at,kind:r.kind,from:r.sender,...metadata,...words,...(r.words && stepCipher?{step:JSON.parse(await key.open(Buffer.from(stepCipher,'base64')))}:{})};
 };
 const sealedRecord = (r: MessageRow): LiveRecord => ({id:messageId(r.thread,r.seq),thread:r.thread,row:r});
 const visibleThread = (t: Thread) => {
  const reply = db.prepare("SELECT max(seq) AS seq FROM comms_messages WHERE thread=? AND kind='reply'").get(t.id) as {seq:number|null};
  const {firstHash, firstId, ...record} = t;
  return {...record,unread:(reply.seq ?? 0)>t.readSeq};
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
 operations.register(operation({name:'comms.agents',doors:['socket'],windowOnly:true,input:z.object({}),output,
  may:v=>v.kind==='member',run:ctx=>o.sharing().members[ctx.viewer.id]?.agents ?? [],
 }));
 let closed=false;
 const pending = new Map<string,Promise<void>>();
 function deliver(agent:string,place:string,seq:number):Promise<void> {
  const marker=messageId(place,seq);const prior=pending.get(marker);if(prior)return prior;
  if(closed)return Promise.resolve();
  const task=performDelivery(agent,place,seq).finally(()=>pending.delete(marker));pending.set(marker,task);return task;
 }
 async function performDelivery(agent:string,place:string,seq:number) {
  try {
   let t=requireAgent(agent,place);
   let row=db.prepare("SELECT * FROM comms_messages WHERE thread=? AND seq=? AND kind='message'").get(place,seq) as MessageRow|undefined;
   if (!row || !row.words || t.archived!==null || !mayUseThread({kind:'member',id:t.member},t,o.sharing())) return;
   if (JSON.parse(row.record).delivery==='delivered') return;
   const plain=await key.open(row.words);const words=JSON.parse(row.record).encoding==='text'?{text:plain}:JSON.parse(plain) as {text:string};
   // Recheck after crypto and again inside the staging hold before crossing the process boundary.
   await o.hold(async()=> {
    if(closed)return;
    t=requireAgent(agent,place);
    row=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(place,seq) as MessageRow|undefined;
    if (!row?.words || t.archived!==null || !mayUseThread({kind:'member',id:t.member},t,o.sharing())) return fail('denied','Thread unavailable');
    await o.runtime.deliver({thread:place,agent,member:t.member,conversation:t.conversation,seq,text:words.text,...(t.project?{project:t.project}:{})});
   });
   settle(place,seq,'delivered');
  } catch { settle(place,seq,'failed'); }

 }
 function settle(place:string,seq:number,delivery:string) {
  if(closed)return;
  const t=thread(db,place); if(!t)return;
  const row=db.prepare('SELECT record FROM comms_messages WHERE thread=? AND seq=?').get(place,seq) as {record:string}|undefined;
  if(!row)return;
  db.prepare('UPDATE comms_messages SET record=? WHERE thread=? AND seq=?').run(JSON.stringify({...JSON.parse(row.record),delivery}),place,seq);
  touched(t,seq);
 }
 function sendAfter(input:unknown,answer: {ok:true;value:unknown}|{ok:false}) {
  if(!answer.ok)return;
  const value=answer.value as {thread:string;seq:number};
  const t=thread(db,value.thread); if(t)void deliver(t.agent,t.id,value.seq);
 }
 operations.register(operation({name:'comms.open',doors:['socket'],windowOnly:true,write:true,
  input:z.object({agent:id,id,text,project:id.optional()}),output,
  may:(v,i)=>v.kind==='member' && mayUseThread(v,{member:v.id,agent:i.agent},o.sharing()) && (!i.project || maySee(v,{project:i.project},o.sharing()) && maySee({kind:'agent',id:i.agent},{project:i.project},o.sharing())),
  prepare:async i=>({words:await key.seal(JSON.stringify({text:i.text})),hash:key.hash(i.text)}),
  run(ctx,i,raw) {
   const p=raw as {words:Buffer;hash:string};
   const existing=(db.prepare('SELECT record FROM comms_threads WHERE member=?').all(ctx.viewer.id) as {record:string}[]).map(r=>JSON.parse(r.record) as Thread).find(t=>t.firstId===i.id);
   if(existing) { if(existing.agent!==i.agent || existing.firstHash!==p.hash) return fail('conflict','Message id already used'); return {thread:existing.id,seq:1}; }
   const place=`th:${randomUUID()}`;
   const t:Thread={id:place,member:ctx.viewer.id,agent:i.agent,conversation:`cv-${randomUUID()}`,project:i.project,title:null,titledBy:null,pinned:false,archived:null,opened:ctx.now,last:ctx.now,readSeq:0,nextSeq:1,stop:false,firstId:i.id,firstHash:p.hash,working:false};
   saveThread(db,t);
   const {seq}=append(db,t,{id:i.id,kind:'message',at:ctx.now,sender:t.member,words:p.words,hash:p.hash,record:JSON.stringify({delivery:'sending'})});
   ctx.changed('thread',place);ctx.changed('message',messageId(place,seq));return {thread:place,seq};
  },after:(i,r)=>sendAfter(i,r),
 }));
 operations.register(operation({name:'comms.send',doors:['socket'],windowOnly:true,write:true,
  input:target.extend({id,text}),output,may:(v,i)=>writable(v,i),
  prepare:async i=>({words:await key.seal(JSON.stringify({text:i.text})),hash:key.hash(i.text)}),
  run(ctx,i,raw) {
   const t=thread(db,i.thread)!; if(t.archived!==null)return fail('conflict','Unarchive this thread first');
   const p=raw as {words:Buffer;hash:string};let value;
   try {value=append(db,t,{id:i.id,kind:'message',at:ctx.now,sender:t.member,words:p.words,hash:p.hash,record:JSON.stringify({delivery:'sending'})});} catch {return fail('conflict','Message id already used');}
   ctx.changed('thread',t.id);ctx.changed('message',messageId(t.id,value.seq));return {thread:t.id,seq:value.seq};
  },after:(i,r)=>sendAfter(i,r),
 }));
 operations.register(operation({name:'comms.messages',doors:['socket'],windowOnly:true,
  input:target.extend({before:z.number().int().positive().optional()}),output,may:(v,i)=>writable(v,i),
  prepare:async i=> {const rows=messageRows(db,i.thread,i.before);return {rows,records:await Promise.all(rows.map(decode))};},
  run(ctx,i,raw) { const p=raw as {rows:MessageRow[];records:LiveRecord[]}; if(JSON.stringify(messageRows(db,i.thread,i.before))!==JSON.stringify(p.rows))return fail('conflict','Thread changed; load this page again');return p.records; },
 }));
 const changeInput=target.extend({action:z.enum(['title','project','pin','unpin','archive','unarchive','read','stop','delete']),title:title.optional(),project:id.nullable().optional(),seq:z.number().int().nonnegative().optional()});
 operations.register(operation({name:'comms.change',doors:['socket'],windowOnly:true,write:true,input:changeInput,output,may:(v,i)=>writable(v,i),
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
    case 'archive':t.archived=ctx.now;break;
    case 'unarchive':t.archived=null;break;
    case 'read': if(i.seq===undefined)return fail('invalid','A message number is required'); t.readSeq=Math.max(t.readSeq,Math.min(i.seq,t.nextSeq-1));break;
    case 'stop':t.stop=true;break;
    case 'delete':
     db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run(t.id,t.member,t.agent,t.conversation,ctx.now);
     for(const r of messageRows(db,t.id,undefined,2147483647))ctx.changed('message',messageId(t.id,r.seq));
     db.prepare('DELETE FROM comms_threads WHERE id=?').run(t.id);ctx.changed('thread',t.id);return {thread:t.id,conversation:t.conversation};
   }
   saveThread(db,t);ctx.changed('thread',t.id);return {thread:t.id,conversation:t.conversation};
  },
  after(i,result) {if((i.action==='archive'||i.action==='delete')&&result.ok) void o.hold(()=>o.runtime.end((result.value as {conversation:string}).conversation)).catch(()=>{});},
 }));
 operations.register(operation({name:'comms.resend',doors:['socket'],windowOnly:true,write:true,input:target.extend({seq:z.number().int().positive()}),output,may:(v,i)=>writable(v,i),
  run(ctx,i) {const t=thread(db,i.thread)!;const row=db.prepare("SELECT * FROM comms_messages WHERE thread=? AND seq=? AND kind='message'").get(t.id,i.seq) as MessageRow|undefined;
   if(t.archived!==null)return fail('conflict','Unarchive this thread first');
   if(!row?.words)return fail('conflict','Message words are no longer kept');
   return {thread:t.id,seq:i.seq};},after:(i,r)=>sendAfter(i,r),
 }));
 operations.register(operation({name:'comms.answer',doors:['socket'],windowOnly:true,write:true,input:target.extend({ref:id,verdict:z.enum(['yes','no']),words:z.string().max(4000).optional()}),output,may:(v,i)=>writable(v,i),
  // The attention role owns the answer transaction and idempotency. This is a durable encrypted delivery job.
  prepare:async i=>key.seal(JSON.stringify({text:i.words ?? '',ref:i.ref,verdict:i.verdict})),
  run(ctx,i,raw) {const t=thread(db,i.thread)!;const ask=db.prepare("SELECT 1 FROM comms_messages WHERE thread=? AND kind='ask' AND id=?").get(t.id,i.ref);if(!ask)return fail('denied','Ask unavailable');
   const result=append(db,t,{id:`answer:${i.ref}`,kind:'answer',at:ctx.now,sender:t.member,words:raw as Buffer,hash:key.hash(JSON.stringify(i)),record:'{}'});ctx.changed('message',messageId(t.id,result.seq));return {thread:t.id,seq:result.seq};},
  after(i,result) {if(result.ok)void o.hold(()=>o.attention.answer(thread(db,i.thread)!.member,i.ref,i.verdict,i.words)).catch(()=>{});},
 }));
 async function post(agent:string,place:string,raw:AgentPost) {
  const m=z.object({id,kind:z.enum(['reply','card','ask','error']),text,run:id.optional(),tool:z.string().max(100).optional(),state:z.enum(['running','done','failed']).optional(),ref:id.optional(),step:z.record(z.string(),z.unknown()).optional()}).parse(raw);
  requireAgent(agent,place); const words=await key.seal(JSON.stringify({text:m.text,...(m.step?{step:m.step}:{})}));
  return db.transaction(()=> {
   const t=requireAgent(agent,place);if(t.archived!==null)return fail('conflict','Thread archived');
   const meta={run:m.run,tool:m.tool,state:m.state,ref:m.ref};
   const old=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND kind=? AND id=?').get(place,m.kind,m.id) as MessageRow|undefined;
   if(old && m.kind==='card') {
    if(!old.words)return {seq:old.seq}; // A swept step cannot resurrect its words.
    db.prepare('UPDATE comms_messages SET words=?,record=? WHERE thread=? AND seq=?').run(words,JSON.stringify(meta),place,old.seq);touched(t,old.seq);return {seq:old.seq};
   }
   let result;try{result=append(db,t,{id:m.id,kind:m.kind,at:clock.now(),sender:agent,words,hash:key.hash(JSON.stringify(m)),record:JSON.stringify(meta)});}catch{return fail('conflict','Reply id already used');}
   touched(t,result.seq);return {seq:result.seq};
  })();
 }
 let cancel:()=>void=()=>{};
 function sweep() {
  const rows=db.prepare('SELECT thread,seq FROM comms_messages WHERE words IS NOT NULL AND at <= ?').all(clock.now()-days*day) as {thread:string;seq:number}[];
  db.prepare("UPDATE comms_messages SET words=NULL, record=json_remove(record,'$.stepCipher') WHERE at <= ?").run(clock.now()-days*day);
  live.changed(rows.map(r=>({type:'message',id:messageId(r.thread,r.seq)})));
  cancel=clock.at(clock.now()+3600_000,sweep);
 }
 sweep();
 return {post,deliver,
  title(agent,place,value) {title.parse(value); const t=requireAgent(agent,place);if(t.titledBy==='member')return fail('conflict','The member named this thread');t.title=value;t.titledBy='agent';saveThread(db,t);touched(t);},
  status(agent,place) {const t=requireAgent(agent,place);const stop=t.stop;t.stop=false;saveThread(db,t);return {stop,archived:t.archived!==null};},
  async close(){closed=true;cancel();await Promise.all(pending.values());},
 };
}
