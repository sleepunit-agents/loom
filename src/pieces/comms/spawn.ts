import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OperationError, mayUseThread, type Db, type Clock, type Sharing } from '../../core/index.js';
import type { WordsKey } from './crypto.js';
import type { StepConversation } from './conversation-steps.js';
import type { SpawnThread } from './role.js';
import { thread, saveThread, append, type Thread } from './store.js';

interface Options {
 db: Db; clock: Clock; key: WordsKey; sharing(): Sharing; closed(): boolean;
 conversation?(id: string): StepConversation | undefined;
 hashText(text: string): string; changed(t: Thread, seqs: number[]): void;
}
const input=z.object({conversation:z.string().min(1).max(200),text:z.string().min(1).max(40_000).refine(s=>!!s.trim()),
 parent:z.string().min(1).max(200).optional(),run:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional()}).strict();
const base32=(bytes:Buffer)=>{
 let bits=0,value=0,out='';for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){out+='abcdefghijklmnopqrstuvwxyz234567'[(value>>>(bits-5))&31];bits-=5;}}return out;
};
const label=(text:string)=>text.replace(/[\\[\]]/g,'\\$&');
export function spawnCreator(o:Options) {
 const {db,key,clock}=o;
 const denied=():never=>{throw new OperationError('denied','Spawn unavailable');};
 const byConversation=(cv:string)=>(db.prepare('SELECT record FROM comms_threads WHERE json_extract(record,\'$.conversation\')=?').all(cv) as {record:string}[]).map(r=>JSON.parse(r.record) as Thread);
 const owner=(t:Thread)=>mayUseThread({kind:'member',id:t.member},t,o.sharing());
 return async (agent:string,raw:SpawnThread):Promise<{thread:string}>=>{
  const i=input.parse(raw);
  if(i.parent===i.conversation)return denied();
  const metadata=()=>{
   const cv=o.conversation?.(i.conversation);
   if(o.closed()||!cv||cv.agent!==agent||cv.venue!=='spawn'||!cv.version)return denied();
   if(db.prepare('SELECT 1 FROM comms_deleted WHERE conversation=?').get(i.conversation))return denied();
   return {...cv};
  };
  const cv=metadata();
  const existing=()=>{
   const matches=byConversation(i.conversation);
   if(matches.length>1)return denied();
   const t=matches[0];if(t&&(t.agent!==agent||(cv.member!==undefined&&t.member!==cv.member)||!owner(t)))return denied();return t;
  };
  const old=existing();if(old&&cv.member===undefined)return {thread:old.id};
  const parentValue=i.parent?o.conversation?.(i.parent):undefined;
  const parentMetadata=parentValue?{...parentValue}:undefined;
  const parentThreads=i.parent?byConversation(i.parent):[];
  if(parentThreads.length>1)return denied();
  const parent=parentThreads[0];
  if(parent&&(parent.agent!==agent||!owner(parent)||parent.archived!==null))return denied();
  if(parentMetadata&&(parentMetadata.agent!==agent||(cv.member!==undefined&&parentMetadata.member!==undefined&&parentMetadata.member!==cv.member)))return denied();
  if(cv.member!==undefined&&(!cv.member||(parent&&parent.member!==cv.member)))return denied();
  if(old)return {thread:old.id};
  const members=Object.keys(o.sharing().members);
  const member=cv.member??parent?.member??members.find(id=>mayUseThread({kind:'member',id},{member:id,agent},o.sharing()));
  if(!member||!mayUseThread({kind:'member',id:member},{member,agent},o.sharing()))return denied();
  const firstId=base32(createHash('sha256').update(`spawn:${agent}:${i.conversation}`).digest()).slice(0,16);
  const place=`th:${base32(Buffer.from(o.hashText(`${member}\0${agent}\0${firstId}`),'hex')).slice(0,10)}`;
  const free=()=>{
   if(thread(db,place)||db.prepare('SELECT 1 FROM comms_deleted WHERE id=?').get(place))return denied();
  };free();
  const title=(cv.label??'Spawn').slice(0,60).replace(/[\r\n]/g,' ');
  const linked=!!parentMetadata||!!parent;
  const texts=[i.text,...(parent?[`Spawned job: [${label(title)}](/p/comms-preview/thread/${encodeURIComponent(place.replace(/^th:/,''))}) · ${i.conversation}`]:[]),
   ...(linked?[`Asked from [${label(parentMetadata?.label??parent?.title??i.parent!)}](${parent?`/p/comms-preview/thread/${encodeURIComponent(parent.id.replace(/^th:/,''))}`:`/p/comms-preview/conversation/${encodeURIComponent(i.parent!)}`})${i.run?` · ${i.run}`:''}`]:[])];
  // All private payloads are prepared before the single synchronous transaction.
  const sealed=await Promise.all(texts.map(async text=>({words:await key.seal(JSON.stringify({text})),hash:key.hash(text)})));
  const result=db.transaction(()=>{
   if(JSON.stringify(metadata())!==JSON.stringify(cv))return denied();
   if(!mayUseThread({kind:'member',id:member},{member,agent},o.sharing()))return denied();
   if(JSON.stringify(i.parent?o.conversation?.(i.parent):undefined)!==JSON.stringify(parentMetadata))return denied();
   const currentParent=i.parent?byConversation(i.parent):[];
   const routing=(t:Thread|undefined)=>t&&[t.id,t.member,t.agent,t.conversation,t.project,t.archived,t.endGeneration,t.opened,t.firstId];
   if(currentParent.length>1||JSON.stringify(routing(currentParent[0]))!==JSON.stringify(routing(parent))||currentParent[0]&&!owner(currentParent[0]))return denied();
   const winner=existing();if(winner)return {thread:winner.id,repeat:true};
   free();
   const now=clock.now();
   const t:Thread={id:place,member,agent,conversation:i.conversation,title,titledBy:'agent',pinned:false,archived:null,opened:now,last:now,readSeq:0,nextSeq:1,stop:false,firstId,firstHash:o.hashText(i.text),working:false};
   saveThread(db,t);
   let n=0;
   const add=(target:Thread,id:string,kind:string)=>append(db,target,{id,kind,sender:agent,at:now,...sealed[n++],record:JSON.stringify(kind==='message'?{delivery:'delivered'}:{})});
   const childSeqs=[add(t,firstId,'message').seq];
   const parentSeq=parent?add(currentParent[0],`spawn-${i.conversation}`,'reply').seq:undefined;
   if(linked)childSeqs.push(add(t,`parent-${i.parent}`,'reply').seq);
   return {thread:place,repeat:false,childSeqs,parentSeq};
  })();
  if(result.childSeqs){o.changed(thread(db,place)!,result.childSeqs);if(parent&&result.parentSeq!==undefined)o.changed(thread(db,parent.id)!,[result.parentSeq]);}
  return {thread:result.thread};
 };
}
