/** Offline channel-note resolution only. Never opens a configured brief path. */
import type {LegacyBridgeInventory} from './import-source.js';

/** JSON object enumeration in JS sorts integer keys; Python keeps file order.
 * The source has already passed JSON/schema validation. Tokens retain escaped
 * property names and ignore punctuation occurring inside strings. Last duplicate
 * channel_notes wins; duplicate map keys keep their first insertion position.
 */
export function channelBriefOrder(source:string):string[] {
 const tokens=source.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g)??[];
 let depth=0,start=-1,active=false;
 let keys:string[]=[];let seen=new Set<string>();
 for(let i=0;i<tokens.length;i++){
  const token=tokens[i];
  if(depth===1&&token.startsWith('"')&&tokens[i+1]===':'&&JSON.parse(token)==='channel_notes')start=i+2;
  if(i===start){keys=[];seen=new Set();active=token==='{';}
  if(active&&depth===2&&token.startsWith('"')&&tokens[i+1]===':'){
   const key=JSON.parse(token) as string;if(!key.startsWith('_')&&!seen.has(key)){seen.add(key);keys.push(key);}
  }
  if(token==='{'||token==='[')depth++;
  if(token==='}'||token===']'){depth--;if(active&&depth===1)active=false;}
 }
 return keys;
}
export interface SelectedBrief {agent:string;key:string;brief?:string;path:string;sha256:string}
export interface ResolvedBrief {key:string;brief:string;path:string;sha256:string;channels:string[]}
export function resolveChannelBriefs(instance:LegacyBridgeInventory['instances'][number],routes:LegacyBridgeInventory['routes'],documents:SelectedBrief[]) {
 const route=routes.find(r=>r.source===instance.routeSource);
 return (instance.channelNoteOrder??[]).map(key=>{
  const brief=instance.channelNotes[key],channels=route?.noteChannels?.[key];
  const selected=documents.filter(d=>d.agent===instance.agent&&d.key===key&&d.brief===brief);
  if(!channels||selected.length!==1)throw Error('Unresolved offline Bridges configured brief');
  const document=selected[0];
  return {key,brief,path:document.path,sha256:document.sha256,channels:[...channels]};
 });
}
/** Shuttle render_brief selects direct OR parent membership, once per key, in
 * config order. This is deliberately separate from Discord describe's selector.
 */
export function selectChannelBriefs(briefs:ResolvedBrief[],channel:string,parent?:string):ResolvedBrief[] {
 return briefs.filter(b=>b.channels.includes(channel)||(parent!==undefined&&b.channels.includes(parent)));
}
