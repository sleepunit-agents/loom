/** The owning window reads sealed questions here; Attention remains metadata only. */
import {z} from 'zod';
import {operation,OperationError,type Viewer,type LiveRecord} from '../../core/index.js';
import type {Options} from './index.js';
import {commsMetadata} from './role.js';
import type {MessageRow} from './store.js';
const id=z.string().min(1).max(200);
const ref=z.string().regex(/^comms:[0-9a-f]{64}$/);
const projection=z.object({id:ref,agent:id,member:id,source:z.object({kind:z.literal('conversation'),id}),
 privateQuestion:z.object({thread:id,seq:z.number().int().positive()}),state:z.enum(['open','answered','resolved']),
 createdAt:z.number(),changedAt:z.number(),answer:z.object({kind:z.enum(['yes','no','done','dismiss','replied']),
 by:z.object({kind:z.literal('member'),id}),at:z.number(),reply:z.object({thread:id,seq:z.number().int().positive()}).optional()}).optional()});
const question=z.object({ask:z.string(),why:z.string().optional(),if_yes:z.string().optional(),if_no:z.string().optional(),
 href:z.string().optional(),refs:z.array(z.string()).optional(),answers:z.enum(['yes-no','words'])}).strict();
export function installQuestionRead(o:Options & {closed():boolean}) {
 const lookup=(viewer:Viewer,key:string)=>{
  if(o.closed()||viewer.kind!=='member'||!ref.safeParse(key).success||!o.attention.get)return;
  const got=o.attention.get(viewer,{id:key});if(!got.ok)return;
  const parsed=projection.safeParse(got.value);if(!parsed.success)return;const a=parsed.data;
  if(a.id!==key||a.member!==viewer.id)return;
  const route=commsMetadata(o.operations)?.privateThread(viewer,{id:a.source.id,agent:a.agent,member:a.member});
  if(!route||route.id!==a.privateQuestion.thread)return;
  const row=o.db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(route.id,a.privateQuestion.seq) as MessageRow|undefined;
  if(!row||row.id!==key||row.kind!=='ask'||row.sender!==a.agent)return;
  const meta=JSON.parse(row.record);if(meta.encoding!=='ask'||meta.ref!==key)return;
  return {id:key,route,projection:a,row};
 };
 type Snapshot=NonNullable<ReturnType<typeof lookup>>;
 const retained=(s:Snapshot)=>s.row.words!==null&&s.row.at+(o.days??14)*86400_000>o.clock.now();
 const decode=async(s:Snapshot)=>{
  const words=retained(s)?question.parse(JSON.parse(await o.key.open(s.row.words!))):null;
  const a=s.projection;
  return {id:s.id,thread:s.route.id,seq:s.row.seq,state:a.state,createdAt:a.createdAt,changedAt:a.changedAt,
   ...(a.answer?{answer:a.answer}:{}),keepUntil:s.row.at+(o.days??14)*86400_000,question:retained(s)?words:null};
 };
 o.operations.register(operation({name:'comms.question',doors:['socket'],windowOnly:true,input:z.object({ref}).strict(),output:z.unknown(),
  may:(viewer,input)=>!!lookup(viewer,input.ref),
  async prepare(input,{viewer}){const snapshot=lookup(viewer,input.ref);if(!snapshot)throw new OperationError('denied','Question unavailable');return {snapshot,value:await decode(snapshot)};},
  run(ctx,input,raw){
   const prepared=raw as {snapshot:Snapshot;value:Awaited<ReturnType<typeof decode>>},current=lookup(ctx.viewer,input.ref);
   if(!current||JSON.stringify(current)!==JSON.stringify(prepared.snapshot))throw new OperationError('denied','Question changed; check it again');
   return {...prepared.value,question:retained(current)?prepared.value.question:null};
  },
 }));
 o.live.register({name:'comms.question',windowOnly:true,
  // Each known Attention ref is its own bounded scope. No global private index.
  ids:scope=>scope&&ref.safeParse(scope).success?[scope]:[],
  read:(key,viewer)=>{const s=lookup(viewer,key);return s?{id:key,snapshot:s,retained:retained(s)}:undefined;},
  resolve:async(record:LiveRecord)=>decode(record.snapshot as Snapshot),
  inScope:(record,scope)=>record.id===scope,
  refreshOn:change=>change.type==='attention.ask'||change.type==='thread'||change.type==='message',
  expires:record=>record.retained?(record.snapshot as Snapshot).row.at+(o.days??14)*86400_000:undefined,
 });
}
