/** Notices an agent's script raises for the people who have that agent: "the disk is full", "the backup did
 * not run". Made the way loom makes its own notices (a silent machine, mail that got no job): an Inbox item
 * of source `notice`, private to its recipient, cleared by resolving it.
 *
 * Who may raise one, and for whom, is not input. The agent is the credential's own (policy.ts, rule
 * `agentItself`, the rule `household.propose` asks). The recipients are the members who have that agent on
 * their own list, or the household owners when nobody has it: the people the existing "mail was not
 * admitted" notice goes to (policy.ts, `agentsPeople`). The agent learns whether its own notice is still
 * waiting, which it needs so as not to raise it twice, and nothing else of anybody's Inbox: it is told its
 * own key, whether the notice was news, and whether any push was queued. Not who has it, how many people or
 * phones, who settled it or when. */
import {randomUUID} from 'node:crypto';
import {and,eq,or,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {inbox} from './core/data/schema.js';
import {Conversations} from './core/conversations/index.js';
import type {Clock} from './core/clock.js';
import {OperationError,type Operations} from './core/operations/index.js';
import {agentsPeople,holds,rules,type Viewer} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
import {QUIET_SOURCE} from './core/data/inbox-push.js';

/** The limits, stated once. A title is one line of an Inbox; a detail is a short paragraph. An agent may have
 * this many keys waiting at once. A person whose notice of a key was settled, and who gets it again within
 * this time, gets it filed without a push, then or ever: an alert that flaps is news once. */
export const NOTICE_TITLE_MAX = 200;
export const NOTICE_DETAIL_MAX = 2000;
export const NOTICE_WHY_MAX = 500;
export const NOTICE_KEYS_MAX = 50;
export const NOTICE_PUSH_AGAIN_MS = 10 * 60_000;
export const NOTICE_KEY_MAX = 120;
const key=z.string().max(NOTICE_KEY_MAX).regex(/^[A-Za-z0-9][A-Za-z0-9:._@-]*$/);
const line=(max:number)=>z.string().trim().min(1).max(max);

export interface NoticePushes{
 /** Queue a push of these items for this person's devices, inside the caller's write. How many were queued. */
 enqueue(member:string,ids:readonly string[]):number;
 /** Send what is queued, once the write is committed. */
 flush():void;
}
export function registerSharedNotices(operations:Operations,db:DataDatabase,clock:Clock,own:(viewer:Viewer)=>Readonly<{agent:string}>|undefined,pushes:()=>NoticePushes|undefined){
 const now=()=>new Date(clock.now()).toISOString();
 const agent=(viewer:Viewer)=>{const found=own(viewer);return found&&holds(rules.agentItself,viewer,{agent:found.agent},sharedSharing(db))?found.agent:undefined;};
 // One raising of a key for one person is one source id: the agent, the key and a fresh id, under one of
 // two beginnings. The quiet one is the mark that the item is never pushed (core/data/inbox-push.ts).
 const LOUD='agent-notice:';
 const prefix=(name:string,k:string,quiet:boolean)=>(quiet?QUIET_SOURCE:LOUD)+JSON.stringify([name,k])+':';
 const keyOf=(sourceId:string)=>sourceId.slice(sourceId.startsWith(QUIET_SOURCE)?QUIET_SOURCE.length:LOUD.length,sourceId.lastIndexOf(':'));
 const ofKey=(name:string,k:string)=>{const starts=[prefix(name,k,false),prefix(name,k,true)];
  return db.select().from(inbox).where(and(eq(inbox.source,'notice'),eq(inbox.fromKind,'agent'),eq(inbox.fromId,name),or(...starts.map(start=>sql`substr(${inbox.sourceId}, 1, ${start.length}) = ${start}`)))).all();};
 const common={write:true,recheckPolicy:true,doors:['http'] as ['http'],may:(viewer:Viewer)=>!!agent(viewer),after(){pushes()?.flush();}};
 operations.register({...common,name:'notices.raise',
  input:z.object({key,title:line(NOTICE_TITLE_MAX),detail:line(NOTICE_DETAIL_MAX).optional(),quiet:z.boolean().optional()}).strict(),
  output:z.object({item:z.string(),raised:z.boolean(),pushed:z.boolean()}).strict(),
  run(ctx,input){
   const name=agent(ctx.viewer);if(!name)throw new OperationError('denied','An agent\'s own credential is required');
   const mail=new Conversations(db,now),all=ofKey(name,input.key),people=agentsPeople(name,sharedSharing(db));
   // Who has the agent is read again on every raise. A notice waiting for someone who no longer has it is
   // settled as it stands: the new words are for the people who have the agent now.
   for(const row of all.filter(row=>row.state==='waiting'&&!people.includes(row.to))){mail.resolveItem(row.id,row.to+' no longer has '+name);ctx.changed('inbox',row.id);}
   const waiting=new Map(all.filter(row=>row.state==='waiting'&&people.includes(row.to)).map(row=>[row.to,row]));
   if(!waiting.size){
    const open=new Set(db.select({sourceId:inbox.sourceId}).from(inbox).where(and(eq(inbox.source,'notice'),eq(inbox.fromKind,'agent'),eq(inbox.fromId,name),eq(inbox.state,'waiting'))).all().map(row=>keyOf(row.sourceId!)));
    if(open.size>=NOTICE_KEYS_MAX)throw new OperationError('conflict','This agent already has '+NOTICE_KEYS_MAX+' notices waiting; clear one first');
   }
   let pushed=false;
   for(const member of people){
    const had=waiting.get(member);
    // Already waiting for this person: the same notice, brought up to date. Nobody is told twice.
    if(had){mail.restate(had.id,{words:input.title,why:input.detail??null});ctx.changed('inbox',had.id);continue;}
    // New to this person. It is filed without ever being pushed when the caller asks for quiet, and when
    // this person's notice of this key was settled a moment ago: an alert that flaps is news once.
    const lately=all.some(row=>row.to===member&&row.state!=='waiting'&&clock.now()-Date.parse(row.changedAt)<NOTICE_PUSH_AGAIN_MS);
    const quiet=input.quiet===true||lately;
    const item=mail.send({toKind:'person',to:member,member,source:'notice',sourceId:prefix(name,input.key,quiet)+randomUUID(),fromKind:'agent',fromId:name,words:input.title,why:input.detail??null,refs:[name]});
    if(!quiet&&(pushes()?.enqueue(member,[item.id])??0)>0)pushed=true;
    ctx.changed('inbox',item.id);
   }
   // `raised`: nobody who has the agent had this key waiting, so it is news. `pushed`: some phone was told.
   return{item:input.key,raised:!waiting.size,pushed};
  },
 });
 operations.register({...common,name:'notices.clear',
  input:z.object({key,why:line(NOTICE_WHY_MAX)}).strict(),output:z.object({cleared:z.boolean()}).strict(),
  run(ctx,input){
   const name=agent(ctx.viewer);if(!name)throw new OperationError('denied','An agent\'s own credential is required');
   const mail=new Conversations(db,now),waiting=ofKey(name,input.key).filter(row=>row.state==='waiting');
   for(const row of waiting){mail.resolveItem(row.id,input.why);ctx.changed('inbox',row.id);}
   return{cleared:waiting.length>0};
  },
 });
}
