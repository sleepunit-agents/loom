/** Owning venue-read authority. No public operation accepts or serializes permits. */
import { z } from 'zod';
import { isClosing, type Foundation } from '../../core/app.js';
import { mayAct, type Sharing, type Viewer } from '../../core/index.js';
import { isDiscordId, type SlackDescribePermit, type DiscordHistoryPermit } from '../bridges/role.js';
import type { ClockProvenanceReader } from './role.js';
import { runtimeHouseDestination } from './role.js';
import { runtimeStore } from './store.js';
import { runtimeDestination } from './destination.js';
const snowflake=z.string().refine(isDiscordId);
const place=z.object({workspace:snowflake,channel:snowflake,kind:z.enum(['channel','thread'])}).strict();
export type DiscordHistoryPlace=z.infer<typeof place>;
const slackPlace=z.object({venue:z.string().min(1).max(200),workspace:z.string().regex(/^T[A-Z0-9]{1,199}$/),kind:z.enum(['dm','group']),place:z.string()}).strict().refine(p=>p.kind==='dm'?/^[UW][A-Z0-9]{1,199}$/.test(p.place)&&p.place!=='USLACKBOT':/^G[A-Z0-9]{1,199}$/.test(p.place));
export type SlackDescribePlace=z.infer<typeof slackPlace>;
const slackIssuers=new WeakMap<Foundation['db'],(viewer:Viewer,request:SlackDescribePlace)=>SlackDescribePermit|undefined>();
const issuers=new WeakMap<Foundation['db'],(viewer:Viewer,request:DiscordHistoryPlace)=>DiscordHistoryPermit|undefined>();
/** Installed only by next-mode composition, with Runtime's actual source reader. */
export function installVenueHistory(app:Foundation,sharing:()=>Sharing,source:ClockProvenanceReader) {
 const store=runtimeStore(app.db);
 const currentRead=(viewer:Viewer)=>{
  const resolve=()=>{
   if(isClosing(app))return;
   const house=runtimeHouseDestination(app,sharing,viewer),authority=source(viewer);
   if(!house||house.service!==undefined||!authority||authority.service!==undefined||authority.agent!==house.agent
    ||authority.principal.for!=='owner'||!authority.member)return;
   const job=store.read('job',house.job),binding=store.read('binding',authority.conversation);
   // This first issuer supports only the existing private Comms source. Its
   // reader verifies the live, unarchived thread and retained sender history.
   // A typed conversation, bridge route or scheduled principal is insufficient.
   if(!job||job.state!=='running'||job.conversation!==authority.conversation||job.member!==authority.member
    ||job.project!==authority.project||!binding||binding.venue!=='loom'||binding.job!==job.id
    ||!mayAct({kind:'member',id:authority.member},{agent:house.agent,member:authority.member,project:authority.project},sharing(),'household'))return;
   return JSON.stringify({destination:runtimeDestination(app.db,job),authority});
  };
  let original:string|undefined;
  try{original=resolve();}catch{return;}
  if(!original)return;
  return ()=>{try{return resolve()===original;}catch{return false;}};
 };
 issuers.set(app.db,(viewer,request)=>{
  const parsed=place.safeParse(request);if(!parsed.success)return;
  const current=currentRead(viewer);if(!current)return;
  return Object.freeze({agent:viewer.id,...parsed.data,current});
 });
 slackIssuers.set(app.db,(viewer,request)=>{
  const parsed=slackPlace.safeParse(request);if(!parsed.success)return;
  const current=currentRead(viewer);if(!current)return;
  return Object.freeze({agent:viewer.id,...parsed.data,current});
 });
 app.onClose(()=>{issuers.delete(app.db);slackIssuers.delete(app.db);});
}
/** Trusted role only. The exact Viewer must come from Signin; copying it loses
 * body proof. No caller-supplied sender, principal, run or grant is accepted.
 * Bridges still owns fresh platform evidence, credentials and staging checks.
 */
export function runtimeDiscordHistoryPermit(app:Foundation,viewer:Viewer,request:DiscordHistoryPlace):DiscordHistoryPermit|undefined {
 return issuers.get(app.db)?.(viewer,request);
}

/** Exact-place platform inspection only. No sender, tier, brief or wake authority.
 * Uses the same live authenticated owner Comms boundary as history. */
export function runtimeSlackDescribePermit(app:Foundation,viewer:Viewer,request:SlackDescribePlace):SlackDescribePermit|undefined {
 return slackIssuers.get(app.db)?.(viewer,request);
}
