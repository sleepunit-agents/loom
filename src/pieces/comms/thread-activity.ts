import { z } from 'zod';
import { OperationError, type Db, type Clock, type LiveRecord } from '../../core/index.js';
import { append, saveThread, type Thread, type MessageRow } from './store.js';
import type { WordsKey } from './crypto.js';
import type { ThreadActivity } from './role.js';

const identity=z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);
const line=(max:number)=>z.string().max(max).refine(s=>!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s));
const shown=/^(?:(?![\p{Cf}])[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029]|\x1b\[[0-9;]{0,30}m)*$/u;
const iso=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/).refine(s=>Number.isFinite(Date.parse(s)));
const bodyTools=new Set(['Edit','MultiEdit','Write','text']);
const card=z.object({id:identity,tool:z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),summary:line(120).min(1),state:z.enum(['running','done','failed']),
 at:z.unknown().optional(),end:iso.optional(),detail:z.string().max(4000).refine(s=>!s.includes('\x1b')&&shown.test(s)).optional(),
 body:z.unknown().optional(),result:line(120).optional(),exit:z.number().int().min(-999999).max(999999).optional(),
 limit:z.number().int().min(1).max(86400).optional(),parent:identity.optional(),
 items:z.array(z.object({text:line(100).min(1),state:z.enum(['done','now','todo'])}).strict()).max(20).optional(),
}).strict().transform(c=>({...c,body:bodyTools.has(c.tool)&&c.body!==undefined?z.string().max(32000).refine(s=>shown.test(s)).parse(c.body):undefined}));
const input=z.object({run:z.string().min(1).max(128),cards:z.array(card).max(50),
 alive:z.object({at:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),tokens:z.number().int().min(0).max(1e12).optional()}).strict().optional(),
}).strict().refine(v=>v.cards.length>0||v.alive!==undefined).refine(v=>new Set(v.cards.map(c=>c.id)).size===v.cards.length);
interface Options {
 db:Db; clock:Clock; key:WordsKey; days:number;
 available(agent:string,place:string):Thread;
 decode(row:MessageRow):Promise<LiveRecord>;
 changed(t:Thread,seqs:number[]):void;
}
/** All private parts, including timing and tool identities, are sealed together.
 * This role accepts runtime-produced cards, never arbitrary window/tool arguments. */
export function threadActivity(o:Options) {
 const {db,clock,key}=o,retention=o.days*86400_000;
 const conflict=():never=>{throw new OperationError('conflict','Thread changed; retry activity');};
 const oldRow=(place:string,id:string)=>db.prepare("SELECT * FROM comms_messages WHERE thread=? AND kind='card' AND id=?").get(place,id) as MessageRow|undefined;
 return async (agent:string,place:string,raw:ThreadActivity)=>{
  const value=input.parse(raw),before=o.available(agent,place),at=clock.now();
  const snapshots=value.cards.map(c=>oldRow(place,c.id));
  // Read imported/current envelopes through the same authorized decoder. No crypto in SQLite.
  const prepared=await Promise.all(value.cards.map(async(c,n)=>{
   const old=snapshots[n];
   if(old&&(!old.words||old.at+retention<=clock.now()))return;
   const prior=old?await o.decode(old):undefined;
   if(old&&old.at+retention<=clock.now())return;
   const legacy=prior?.card as Record<string,unknown>|undefined;
   const was=(prior?.step??legacy??{}) as Record<string,unknown>;
   const tool=typeof prior?.tool==='string'?prior.tool:typeof legacy?.tool==='string'?legacy.tool:c.tool;
   const previousState=prior?.state??legacy?.state;
   const start=typeof was.t0==='string'?was.t0:iso.safeParse(c.at).success?c.at as string:undefined;
   const instant=tool==='text'||tool==='TodoWrite'||tool==='todo_list';
   const end=c.state==='running'?undefined:c.end??(typeof was.t1==='string'?was.t1:old?(previousState==='running'?new Date(at).toISOString():undefined):instant?start??new Date(at).toISOString():new Date(at).toISOString());
   const step={...(c.detail!==undefined?{detail:c.detail}:{}),...(c.body!==undefined&&bodyTools.has(tool)?{body:c.body}:{}),
    ...(c.result!==undefined?{result:c.result}:{}),...(c.items!==undefined?{items:c.items}:{}),
    ...(c.exit!==undefined?{exit:c.exit}:{}),...(c.limit!==undefined?{limit:c.limit}:{}),...(c.parent!==undefined?{parent:c.parent}:{}),
    ...(start?{t0:start}:{}),...(end?{t1:end}:{})};
   const payload=JSON.stringify({text:c.summary,run:value.run,tool,state:c.state,step});
   return {old,words:await key.seal(payload),hash:key.hash(payload)};
  }));
  const result=db.transaction(()=>{
   const t=o.available(agent,place);
   if(t.member!==before.member||t.conversation!==before.conversation||t.project!==before.project||t.endGeneration!==before.endGeneration||t.opened!==before.opened||t.firstId!==before.firstId)return conflict();
   if(at+retention<=clock.now())return conflict();
   if(value.cards.some((c,n)=>JSON.stringify(oldRow(place,c.id))!==JSON.stringify(snapshots[n])))return conflict();
   let added=0,updated=0;const seqs:number[]=[];
   for(let n=0;n<prepared.length;n++){
    const p=prepared[n];if(!p)continue;
    if(p.old){
     if(p.old.at+retention<=clock.now())continue;
     db.prepare("UPDATE comms_messages SET words=?,record='{}' WHERE thread=? AND seq=?").run(p.words,place,p.old.seq);updated++;seqs.push(p.old.seq);
    }else{
     const r=append(db,t,{id:value.cards[n].id,kind:'card',at,sender:agent,words:p.words,hash:p.hash,record:'{}'});added++;seqs.push(r.seq);
    }
   }
   // A finished late batch never restarts a completed turn. Running cards start one;
   // every batch keeps the beat of an existing turn, without moving thread activity.
   if(t.working||value.cards.some(c=>c.state==='running')){
    t.working=true;t.workingSince??=clock.now();t.workingBeat=clock.now();t.startedThrough=t.nextSeq-1;
   }
   const alive=value.alive;
   if(alive&&alive.at<=clock.now()+60000&&alive.at>(t.aliveAt??0)){t.aliveAt=alive.at;t.aliveTokens=alive.tokens??null;}
   saveThread(db,t);return {added,updated,seqs,t};
  })();
  o.changed(result.t,result.seqs);return {added:result.added,updated:result.updated};
 };
}
