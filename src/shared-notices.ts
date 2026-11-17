/** Notices an agent's script raises for the people who have that agent: "the disk is full", "the backup did
 * not run". Made the way loom makes its own notices (a silent machine, mail that got no job): an Inbox item
 * of source `notice`, private to its recipient, cleared by resolving it.
 *
 * Who may raise one, and for whom, is not input. The agent is the credential's own (policy.ts, rule
 * `agentItself`, the rule `household.propose` asks). The recipients are the members who have that agent on
 * their own list, or the household owners when nobody has it: the people the existing "mail was not
 * admitted" notice goes to. The agent is told its own key, whether the notice was new, and how many devices
 * a push was queued for: nothing of anybody's Inbox. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {inbox} from './core/data/schema.js';
import {Conversations} from './core/conversations/index.js';
import {InboxVolume} from './core/tempo/volume.js';
import type {Clock} from './core/clock.js';
import {OperationError,type Operations} from './core/operations/index.js';
import {holds,membersWithAgent,rules,type Viewer} from './policy.js';
import {householdOwners,sharedSharing} from './shared-sharing.js';

/** The limits, stated once. A title is one line of an Inbox; a detail is a short paragraph. An agent may have
 * this many keys waiting at once. A key that was cleared and is raised again within this time is filed
 * without a push: a thing that flaps is news once. */
export const NOTICE_TITLE_MAX = 200;
export const NOTICE_DETAIL_MAX = 2000;
export const NOTICE_WHY_MAX = 500;
export const NOTICE_KEYS_MAX = 50;
export const NOTICE_PUSH_AGAIN_MS = 10 * 60_000;
const key=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._@-]{0,119}$/);
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
 // One raising of a key is one source id: the agent, the key and a fresh id. Every item of the key, waiting or not, begins with the same words.
 const prefix=(name:string,k:string)=>'agent-notice:'+JSON.stringify([name,k])+':';
 const ofKey=(name:string,k:string)=>{const start=prefix(name,k);return db.select().from(inbox).where(and(eq(inbox.source,'notice'),eq(inbox.fromKind,'agent'),eq(inbox.fromId,name),sql`substr(${inbox.sourceId}, 1, ${start.length}) = ${start}`)).all();};
 const recipients=(name:string)=>{const has=membersWithAgent(name,sharedSharing(db));return has.length?has:householdOwners(db);};
 const common={write:true,recheckPolicy:true,doors:['http'] as ['http'],may:(viewer:Viewer)=>!!agent(viewer),after(){pushes()?.flush();}};
 operations.register({...common,name:'notices.raise',
  input:z.object({key,title:line(NOTICE_TITLE_MAX),detail:line(NOTICE_DETAIL_MAX).optional(),quiet:z.boolean().optional()}).strict(),
  output:z.object({item:z.string(),raised:z.boolean(),devices:z.number().int().min(0)}).strict(),
  run(ctx,input){
   const name=agent(ctx.viewer);if(!name)throw new OperationError('denied','An agent\'s own credential is required');
   const mail=new Conversations(db,now),all=ofKey(name,input.key),waiting=all.filter(row=>row.state==='waiting');
   if(waiting.length){
    // Already raised and still waiting: the same notice, brought up to date. Nobody is told twice.
    for(const row of waiting){mail.restate(row.id,{words:input.title,why:input.detail??null});ctx.changed('inbox',row.id);}
    return{item:input.key,raised:false,devices:0};
   }
   const open=new Set(db.select({sourceId:inbox.sourceId}).from(inbox).where(and(eq(inbox.source,'notice'),eq(inbox.fromKind,'agent'),eq(inbox.fromId,name),eq(inbox.state,'waiting'))).all().map(row=>row.sourceId!.slice(0,row.sourceId!.lastIndexOf(':'))));
   if(open.size>=NOTICE_KEYS_MAX)throw new OperationError('conflict','This agent already has '+NOTICE_KEYS_MAX+' notices waiting; clear one first');
   // Cleared a moment ago and back again: filed, and not pushed a second time.
   const lately=all.some(row=>clock.now()-Date.parse(row.changedAt)<NOTICE_PUSH_AGAIN_MS);
   const quiet=input.quiet===true||lately,volume=new InboxVolume(db,clock);
   let devices=0;
   for(const member of recipients(name)){
    const item=mail.send({toKind:'person',to:member,member,source:'notice',sourceId:prefix(name,input.key)+randomUUID(),fromKind:'agent',fromId:name,words:input.title,why:input.detail??null,refs:[name]});
    if(quiet)volume.set({kind:'person',id:member},item.id,'dim');
    else devices+=pushes()?.enqueue(member,[item.id])??0;
    ctx.changed('inbox',item.id);
   }
   return{item:input.key,raised:true,devices};
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
