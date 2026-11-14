/** Reverse provenance is resolved by Comms, never by the referring piece. */
import { mayUseThread, type Db, type Live, type Sharing, type Viewer } from '../../core/index.js';
import type { Thread } from './store.js';
interface Options {db:Db;live:Live;sharing():Sharing;active():boolean}
export function installCommsFrom(o:Options) {
 const read=(id:string,viewer:Viewer)=>{
  const sharing=o.sharing();
  if(!o.active()||viewer.kind!=='member'||!Object.hasOwn(sharing.members,viewer.id)||!id||id.length>200)return;
  const plain={id,label:'From a conversation'};
  // Inspect only this namespace. Ambiguous or damaged routing never yields a title.
  const t=consistentConversation(o.db,id);if(!t)return plain;
  if(!mayUseThread(viewer,{member:viewer.id,agent:t.agent},sharing))return plain;
  if(!mayUseThread(viewer,t,sharing))return {id,label:'From a Comms thread'};
  if(!/^th:[a-z0-9-]+$/.test(t.id))return plain;
  return {id,label:`From: ${t.title??`New thread with ${t.agent}`}`,url:`/p/comms-preview/thread/${t.id.replace(/^th:/,'')}`};
 };
 o.live.register({name:'commsFrom',windowOnly:true,ids:scope=>scope?[scope]:[],read,
  inScope:(record,scope)=>record.id===scope,
  refreshOn:change=>['thread','core.access','household.sharing'].includes(change.type),
 });
}

/** A chip may reveal metadata only to the thread's current original member. */
export function ownedConversation(db:Db,sharing:Sharing,viewer:Viewer,id:string):Thread|undefined {
 if(viewer.kind!=='member'||!/^cv-[0-9a-f]{12}$/.test(id))return;
 const t=consistentConversation(db,id);
 return t&&mayUseThread(viewer,t,sharing)?t:undefined;
}
/** Shared metadata integrity check; callers independently decide disclosure. */
function consistentConversation(db:Db,id:string):Thread|undefined {
 const rows=db.prepare("SELECT id,agent,member,project,record FROM comms_threads WHERE json_extract(record,'$.conversation')=? LIMIT 2").all(id) as {id:string;agent:string;member:string;project:string|null;record:string}[];
 if(rows.length!==1)return;
 const {record,...row}=rows[0],t=JSON.parse(record) as Thread;
 if(t.id!==row.id||t.agent!==row.agent||t.member!==row.member||(t.project??null)!==row.project||t.conversation!==id
  ||!/^th:[a-z0-9-]+$/.test(t.id)
  ||db.prepare('SELECT 1 FROM comms_deleted WHERE conversation=? OR id=?').get(id,t.id))return;
 return t;
}
