/** Offline source resolution. Never applies legacy gates, offers or proposals. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { readBridgeInventory, projectBridgeDocument, type BridgeSourceFile, type LegacyBridgeInventory } from './import-source.js';
import { readBridgeStoreInventory, type BridgeStoreFile } from './import-stores.js';
import { venueSchema, routeSchema, linkSchema, type Venue, type Route, type PersonLink } from './model.js';
const name=z.string().min(1).max(200);
export const bridgeImportOptions=z.object({
  instances:z.array(z.object({shuttle:name,people:name,routes:name}).strict()),
  connections:z.array(z.object({agent:name,platform:z.enum(['discord','slack']),workspace:name,bot:name,tokenSecret:name,appSecret:name.optional()}).strict()),
}).strict();
export type BridgeImportOptions=z.infer<typeof bridgeImportOptions>;
export interface BridgeImportSources {files:BridgeSourceFile[];stores:BridgeStoreFile[]}
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`:JSON.stringify(value);
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const object=z.record(z.string(),z.unknown());
// Assembly must not round a stored platform ID before the shared projection sees it.
const parse=(raw:string):Record<string,unknown>=>object.parse(JSON.parse(raw,(_k:string,v:unknown,c?:{source?:string})=>{
  if(typeof v==='number'&&(!c?.source||!/^(0|[1-9]\d*)$/.test(c.source)||!Number.isSafeInteger(v)))throw Error();return v;
}));
const empty=():LegacyBridgeInventory=>({checksum:'',sources:[],instances:[],settings:[],accounts:[],routes:[]});
/** Resolve the pinned shuttle routes_for/assemble contract, refusing lossy conflicts. */
function acceptedRoutes(agent:string,get:(collection:string,key:string)=>string|undefined,parts:Map<string,string>):string|undefined {
  const household=get('routes','household');
  if(household===undefined||!parts.has(agent))return;
  const h=parse(household), own=parse(parts.get(agent)!);
  const offer=get('route-offers',agent);
  if(offer!==undefined){
    const offered=parse(offer).doc;
    if(offered&&typeof offered==='object'&&!Array.isArray(offered)){
      const d=offered as Record<string,unknown>,wanted=new Set(Object.keys(object.parse(d.bots??{})));
      for(const section of ['channels','threads'])for(const c of Object.values(object.parse(d[section]??{}))) {const primary=object.parse(c).primary;if(typeof primary==='string'&&primary)wanted.add(primary);}
      if([...wanted].some(a=>!parts.has(a)))return;
      const extras=Object.keys(d).filter(k=>!['bots','bot_roles','channels','threads','notify','guild','webhook_peers','peer_turns_each','guests'].includes(k)&&!k.startsWith('_'));
      if(extras.length&&!own.extra)return;
    }
  }
  const out:Record<string,unknown>={};
  for(const k of ['guild','webhook_peers','peer_turns_each','guests'])if(Object.hasOwn(h,k))out[k]=h[k];
  const bots:Record<string,unknown>={},roles:Record<string,unknown>={},channels:Record<string,Record<string,unknown>>={},threads:Record<string,unknown>={},claims=new Map<string,string[]>();
  for(const [cid,n]of Object.entries(object.parse(h.channel_names??{})))channels[cid]={name:n,primary:null};
  for(const [a,raw]of [...parts].sort(([a],[b])=>a<b?-1:1)){
    const p=parse(raw);if(p.bot)bots[a]=p.bot;if(p.bot_role)roles[a]=p.bot_role;
    for(const cid of Object.keys(object.parse(p.answers??{})))claims.set(cid,[...(claims.get(cid)??[]),a]);
    for(const [tid,rawThread]of Object.entries(object.parse(p.threads??{}))){
      const t=Object.fromEntries(Object.entries(object.parse(rawThread)).filter(([k])=>!['peer','pair','guest_venue','readers'].includes(k)));
      if(Object.hasOwn(threads,tid)&&canonical(threads[tid])!==canonical(t))throw Error();threads[tid]=t;
    }
  }
  for(const [cid,agents]of claims){if(agents.length!==1)throw Error();channels[cid]={...(channels[cid]??{}),primary:agents[0]};}
  // A global new-side route cannot represent different per-agent accepted rules.
  const flagKeys=['peer','pair','guest_venue','readers'];
  const flags=(p:Record<string,unknown>,cid:string)=>{
    const raw=object.parse(object.parse(p.flags??{})[cid]??{});
    return {peer:raw.peer??false,pair:raw.pair??null,guest_venue:raw.guest_venue??false,readers:raw.readers??[]};
  };
  const saved=[...parts.values()].map(parse);
  for(const p of saved)for(const cid of Object.keys(object.parse(p.flags??{})))channels[cid]??={primary:null};
  for(const [cid,c]of Object.entries(channels)){
    const f=flags(own,cid);if(saved.some(p=>canonical(flags(p,cid))!==canonical(f)))throw Error();
    for(const k of flagKeys)c[k]=f[k as keyof typeof f];
  }
  Object.assign(out,{bots,bot_roles:roles,channels,threads});
  // Extras never override the assembled accepted map. Unknown fields remain in private store evidence.
  for(const [k,v]of Object.entries(object.parse(own.extra??{})))if(!Object.hasOwn(out,k))out[k]=v;
  return JSON.stringify(out);
}
export function readBridgeImport(sources:BridgeImportSources,rawOptions:unknown,household:{agents:string[];members:string[]},open:(path:string)=>Database.Database){
  try{
    const options=bridgeImportOptions.parse(rawOptions),inventory=sources.files.length?readBridgeInventory(sources.files):empty();
    const stores=sources.stores.length?readBridgeStoreInventory(sources.stores,open):{stores:[],checksum:hash('[]')};
    const byName=new Map(sources.files.map(f=>[f.name,f]));
    const get=(kind:'shuttle'|'runtime',collection:string,key:string)=>stores.stores.find(s=>s.kind===kind)?.documents.find(d=>d.collection===collection&&d.key===key)?.doc;
    const parts=new Map((stores.stores.find(s=>s.kind==='shuttle')?.documents??[]).filter(d=>d.collection==='channels').map(d=>[d.key,d.doc]));
    const effective=empty(),used=new Set<string>(),agents=new Set<string>();
    for(const instance of options.instances){
      for(const [kind,n]of Object.entries(instance)){if(byName.get(n)?.kind!==kind||used.has(n))throw Error();used.add(n);}
      const s=inventory.instances.find(s=>s.source===instance.shuttle);if(!s||agents.has(s.agent)||!household.agents.includes(s.agent))throw Error();agents.add(s.agent);
      effective.instances.push(s);
      const runtime=get('runtime','gates',s.agent),shuttle=get('shuttle','people',s.agent);
      if(runtime===undefined&&get('shuttle','moved',s.agent)!==undefined)throw Error();
      const selected=runtime??shuttle;
      if(selected!==undefined)projectBridgeDocument(effective,`accepted:${s.agent}`,'people',selected);
      else effective.accounts.push(...inventory.accounts.filter(a=>a.source===instance.people));
      const routes=acceptedRoutes(s.agent,(c,k)=>get('shuttle',c,k),parts);
      if(routes!==undefined)projectBridgeDocument(effective,`accepted:${s.agent}`,'routes',routes);
      else effective.routes.push(...inventory.routes.filter(r=>r.source===instance.routes));
    }
    for(const f of sources.files)if(!f.kind.endsWith('-settings')&&!used.has(f.name))throw Error();
    // Every declared legacy connection needs an explicit reviewed secret-name mapping.
    const required=new Set<string>();
    for(const s of effective.instances){if(s.discordSecret!==undefined)required.add(`${s.agent}:discord`);if(s.slackBundle!==undefined)required.add(`${s.agent}:slack`);}
    for(const s of inventory.settings)for(const a of Object.keys(s.bots))required.add(`${a}:${s.platform}`);
    const venues:Venue[]=[],routes:Route[]=[],links:PersonLink[]=[];
    for(const c of options.connections){
      if(!household.agents.includes(c.agent)||!required.delete(`${c.agent}:${c.platform}`))throw Error();
      if(c.bot==='0'||c.workspace==='0'||(c.platform==='slack'&&!c.appSecret))throw Error();
      if(c.platform==='discord'){
        const claims=effective.routes.filter(r=>r.bots[c.agent]!==undefined);
        if(!claims.length||claims.some(r=>r.bots[c.agent]!==c.bot||r.guild!==c.workspace))throw Error();
      }
      const configs=c.platform==='discord'?effective.routes.filter(r=>r.guild===c.workspace&&r.bots[c.agent]===c.bot):[];
      const settings=configs.map(r=>({only:r.only,ignore:r.ignore,botRoles:r.botRoles[c.agent]??[]}));
      if(settings.some(r=>canonical(r)!==canonical(settings[0])))throw Error();
      venues.push(venueSchema.parse({...c,...settings[0],id:`legacy:${c.agent}:${c.platform}`,enabled:false}));
    }
    if(required.size)throw Error();
    for(const r of effective.routes){
      if(!r.guild){if(r.channels.length)throw Error();continue;}
      if(!venues.some(v=>v.platform==='discord'&&v.workspace===r.guild))throw Error();
      for(const c of r.channels){
        if(c.primary&&!household.agents.includes(c.primary)||c.readers.some(p=>!household.members.includes(p)))throw Error();
        const {thread,...fields}=c;
        if(thread){
          const parent=r.channels.find(p=>!p.thread&&p.channel===c.parent);
          if(!parent)throw Error();
          Object.assign(fields,{peer:parent.peer,pair:parent.pair,guest:parent.guest,readers:parent.readers});
        }
        const record=routeSchema.parse({id:`legacy:discord:${r.guild}:${c.channel}`,platform:'discord',workspace:r.guild,...fields,notes:[]});
        // thread is source classification, not a setup field.
        routes.push(record);
      }
    }
    for(const a of effective.accounts){
      if(a.kind!=='person')continue;
      if(venues.some(v=>v.platform===a.platform&&v.bot===a.user&&(a.platform==='discord'||v.workspace===a.workspace))||effective.routes.some(r=>a.platform==='discord'&&Object.values(r.bots).includes(a.user))||effective.accounts.some(b=>b.kind==='agent'&&b.platform===a.platform&&b.user===a.user&&(a.platform==='discord'||b.workspace===a.workspace)))throw Error();
      if(!household.members.includes(a.owner)||a.user==='0')throw Error();
      const workspaces=a.platform==='slack'?[a.workspace!]:[...new Set(venues.filter(v=>v.platform==='discord').map(v=>v.workspace))];
      for(const workspace of workspaces)links.push(linkSchema.parse({id:`legacy:${a.platform}:${workspace}:${a.user}`,platform:a.platform,workspace,user:a.user,person:a.owner}));
    }
    const unique=<T extends{id:string}>(records:T[]):T[]=>{
      const out=new Map<string,T>();for(const r of records){const old=out.get(r.id);if(old&&canonical(old)!==canonical(r))throw Error();out.set(r.id,r);}return [...out.values()].sort((a,b)=>a.id<b.id?-1:1);
    };
    const expected={venues:unique(venues),routes:unique(routes),links:unique(links)};
    const evidence=JSON.stringify({inventory,stores}),mapping=canonical(options),checksum=hash(JSON.stringify([inventory.checksum,stores.checksum,mapping]));
    return {expected,evidence,mapping,checksum};
  }catch{throw Error('Invalid offline Bridges import mapping or sources');}
}
