/** Owning venue-read authority. No public operation accepts or serializes permits. */
import { z } from 'zod';
import { isClosing, type Foundation } from '../../core/app.js';
import { mayAct, type Sharing, type Viewer } from '../../core/index.js';
import { isDiscordId } from '../bridges/discord-id.js';
import type { DiscordHistoryPermit } from '../bridges/discord-history.js';
import type { ClockProvenanceReader } from './role.js';
import { runtimeHouseDestination } from './role.js';
import { runtimeStore } from './store.js';
import { runtimeDestination } from './destination.js';
const snowflake=z.string().refine(isDiscordId);
const place=z.object({workspace:snowflake,channel:snowflake,kind:z.enum(['channel','thread'])}).strict();
export type DiscordHistoryPlace=z.infer<typeof place>;
const issuers=new WeakMap<Foundation['db'],(viewer:Viewer,request:DiscordHistoryPlace)=>DiscordHistoryPermit|undefined>();
/** Installed only by next-mode composition, with Runtime's actual source reader. */
export function installVenueHistory(app:Foundation,sharing:()=>Sharing,source:ClockProvenanceReader) {
 const store=runtimeStore(app.db);
 issuers.set(app.db,(viewer,request)=>{
  const parsed=place.safeParse(request);if(!parsed.success)return;
  const exact=Object.freeze(parsed.data);
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
  return Object.freeze({agent:viewer.id,...exact,current(){
   try{return resolve()===original;}catch{return false;}
  }});
 });
 app.onClose(()=>issuers.delete(app.db));
}
/** Trusted role only. The exact Viewer must come from Signin; copying it loses
 * body proof. No caller-supplied sender, principal, run or grant is accepted.
 * Bridges still owns fresh platform evidence, credentials and staging checks.
 */
export function runtimeDiscordHistoryPermit(app:Foundation,viewer:Viewer,request:DiscordHistoryPlace):DiscordHistoryPermit|undefined {
 return issuers.get(app.db)?.(viewer,request);
}
