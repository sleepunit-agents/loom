import {createHash} from 'node:crypto';
import {and,asc,desc,eq,gte,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {bridgeIncoming,bridgeSendJobs,bridgeSendParts,bridgeSends,conversations as rooms} from './core/data/schema.js';
import type {Conversations} from './core/conversations/index.js';
import type {conversationBodyScope} from './core/conversations/body-scope.js';
import {MESSAGE_WORDS_MAX} from './core/conversations/words.js';
import {OperationError,type Operations} from './core/operations/index.js';
import type {Viewer} from './policy.js';
import {conversationPlace} from './pieces/bridges/place.js';
import type {SharedBridges} from './pieces/bridges/shared-daemon.js';
import type {directTargets} from './shared-direct-target.js';
import {BRIDGE_POSTS_PER_JOB} from './shared-bridge-reply.js';

const address=z.object({id:z.uuid(),person:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),via:z.enum(['slack','discord'])}).strict();
type Address=z.infer<typeof address>;
const denied=()=>new OperationError('denied','Direct recipient unavailable for this job');

export function registerBridgeDirect(ops:Operations,db:DataDatabase,conversations:Conversations,
 current:ReturnType<typeof conversationBodyScope>,targets:ReturnType<typeof directTargets>,daemon:SharedBridges,effects:()=>boolean){
 const bind=(viewer:Viewer,input:Address)=>{
  const work=current(viewer);if(!work||viewer.kind!=='agent'||work.cv.agent!==viewer.id)return;
  const bound=targets.resolve(work.job.id,work.cv.id,input.person,input.via);
  if(!bound)return;
  const id='dm:'+createHash('sha256').update(JSON.stringify([work.job.id,work.cv.id,input.id])).digest('hex');
  return {...bound,job:work.job.id,id};
 };
 type Bound=NonNullable<ReturnType<typeof bind>>;
 const own=(bound:Bound)=>db.select({send:bridgeSends,source:bridgeSendJobs}).from(bridgeSends)
  .innerJoin(bridgeSendJobs,eq(bridgeSendJobs.send,bridgeSends.id)).where(and(eq(bridgeSends.id,bound.id),eq(bridgeSendJobs.job,bound.job))).get();
 const same=(a:Bound,b:Bound|undefined)=>!!b&&a.id===b.id&&a.connection===b.connection&&a.target.user===b.target.user&&a.target.member===b.target.member&&a.target.workspace===b.target.workspace;
 const check=(bound:Bound,text:string)=>{
  const prior=own(bound);
  if(prior){
   const old=prior.source.directTarget;
   if(!old||old.channel!==prior.send.channel||old.origin!==bound.target.origin||old.person!==bound.target.person||old.platform!==bound.target.platform||
      old.user!==bound.target.user||old.workspace!==bound.target.workspace||old.member!==bound.target.member||
      prior.send.text!==text||prior.send.connection!==bound.connection)throw new OperationError('conflict','Direct receipt already used');
   return prior.send.channel;
  }
  const count=db.select({n:sql<number>`count(*)`}).from(bridgeSendJobs).where(eq(bridgeSendJobs.job,bound.job)).get()!.n;
  if(count>=BRIDGE_POSTS_PER_JOB)throw new OperationError('conflict','Job post limit reached');
  const since=new Date(Date.parse(conversations.now())-600_000).toISOString();
  const duplicate=db.select({id:bridgeSends.id}).from(bridgeSends).innerJoin(bridgeSendJobs,eq(bridgeSends.id,bridgeSendJobs.send))
   .where(and(eq(bridgeSends.text,text),gte(bridgeSends.createdAt,since),
    sql`json_extract(${bridgeSendJobs.directTarget}, '$.origin') = ${bound.target.origin}`,
    sql`json_extract(${bridgeSendJobs.directTarget}, '$.platform') = ${bound.target.platform}`,
    sql`json_extract(${bridgeSendJobs.directTarget}, '$.workspace') = ${bound.target.workspace}`,
    sql`json_extract(${bridgeSendJobs.directTarget}, '$.user') = ${bound.target.user}`)).get();
  if(duplicate)throw new OperationError('conflict','This message was already queued for this recipient');
 };
 ops.register({name:'bridges.direct',write:true,doors:['http'],recheckPolicy:true,input:address.extend({text:z.string().min(1).max(MESSAGE_WORDS_MAX).refine(text=>!!text.trim())}),
  output:z.object({saved:z.literal(true)}).strict(),may:(v,input)=>!!bind(v,input),
  inputHash:(canonical,{actor})=>createHash('sha256').update(JSON.stringify(['bridge-direct-v1',current(actor)?.job.id,current(actor)?.cv.id,canonical])).digest('hex'),
  async prepare(input,ctx){
   const bound=bind(ctx.viewer,input);if(!bound)throw denied();
   const prior=check(bound,input.text),t=bound.target;
   const permitted=()=>!ctx.signal?.aborted&&same(bound,bind(ctx.viewer,input));
   // A delivered one-to-one message identifies its private channel even while the bridge is offline.
   const cached=db.select({channel:bridgeIncoming.channel,thread:bridgeIncoming.thread,place:rooms.place}).from(bridgeIncoming).innerJoin(rooms,eq(rooms.id,bridgeIncoming.conversation))
    .where(and(eq(bridgeIncoming.connection,bound.connection),eq(bridgeIncoming.user,t.user),eq(bridgeIncoming.isDm,true),
     eq(bridgeIncoming.groupDm,false),eq(bridgeIncoming.state,'delivered'),eq(rooms.agent,bound.agent),eq(rooms.direct,true),eq(rooms.venue,t.platform),
     t.member?eq(bridgeIncoming.member,t.member):isNull(bridgeIncoming.member),
     t.member?eq(rooms.member,t.member):isNull(rooms.member))).orderBy(desc(bridgeIncoming.receivedAt)).get();
   const cachedChannel=cached&&cached.place===conversationPlace(t.workspace,{...cached,isDm:true},t.member)?cached.channel:undefined;
   const channel=prior??cachedChannel??(effects()?await daemon.openDirect(bound.connection,t.user,permitted):undefined);
   if(!channel||!permitted()||!targets.allowed(bound.job,t,bound.connection,channel))throw denied();
   return {bound,channel};
  },
  run(ctx,input,prepared){
   const {bound,channel}=prepared as {bound:Bound;channel:string},t=bound.target;
   if(!same(bound,bind(ctx.viewer,input))||!targets.allowed(bound.job,t,bound.connection,channel))throw denied();
   check(bound,input.text);
   const place=conversationPlace(t.workspace,{channel,isDm:true},t.member);
   const room=conversations.open({agent:bound.agent,venue:t.platform,place,label:'DM with '+t.person,member:t.member,direct:true});
   daemon.sends.queue({id:bound.id,text:input.text,held:!effects(),at:{connection:bound.connection,channel,conversation:room.id,thread:null},
    author:{job:bound.job,intermediate:true,directTarget:{...t,channel}}});
   ctx.changed('bridge-send',bound.id);return {saved:true as const};
  },
 });
 ops.register({name:'bridges.directStatus',write:false,doors:['http'],recheckPolicy:true,input:address,
  output:z.object({state:z.enum(bridgeSends.state.enumValues),postedIds:z.array(z.string())}).strict(),may:(v,input)=>!!bind(v,input),
  run(ctx,input){
   const bound=bind(ctx.viewer,input);if(!bound)throw denied();
   const row=own(bound),t=row?.source.directTarget;
   if(!row||!t||t.channel!==row.send.channel||t.origin!==bound.target.origin||t.person!==input.person||t.platform!==input.via||t.member!==bound.target.member||
      t.user!==bound.target.user||!targets.allowed(bound.job,t,row.send.connection,row.send.channel))throw denied();
   const parts=db.select({id:bridgeSendParts.postedId}).from(bridgeSendParts).where(eq(bridgeSendParts.send,bound.id)).orderBy(asc(bridgeSendParts.part)).all();
   return {state:row.send.state,postedIds:parts.map(p=>p.id)};
  },
 });
}
