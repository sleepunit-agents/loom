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
  connections:z.array(z.object({agent:name,platform:z.enum(['discord','slack']),workspace:name,bot:name.optional(),tokenSecret:name.optional(),appSecret:name.optional(),setupIncomplete:z.literal(true).optional()}).strict()),
}).strict();
export type BridgeImportOptions=z.infer<typeof bridgeImportOptions>;
export interface BridgeImportSources {files:BridgeSourceFile[];stores:BridgeStoreFile[]}
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`:JSON.stringify(value);
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const object=z.record(z.string(),z.unknown());
// Assembly must not round a stored platform ID before the shared projection sees it.
const parse=(raw:string):Record<string,unknown>=>object.parse(JSON.parse(raw,(_k:string,v:unknown,c?:{source?:string})=>{
  if(typeof v==='number'&&(!c?.source||!/^(0|[1-9]\d*)$/.test(c.source)||!Number.isSafeInteger(v)))return NaN;return v;
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
    const p=parse(raw);if(p.bot!=null&&p.bot!=='')bots[a]=p.bot;if(p.bot_role!=null&&p.bot_role!=='')roles[a]=p.bot_role;
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
  return JSON.stringify(out,(_key,value)=>{if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error();return value;});
}
export function readBridgeImport(sources:BridgeImportSources,rawOptions:unknown,household:{agents:string[];members:string[]},open:(path:string)=>Database.Database){
  try{
    const options=bridgeImportOptions.parse(rawOptions),inventory=sources.files.length?readBridgeInventory(sources.files):empty();
    const stores=sources.stores.length?readBridgeStoreInventory(sources.stores,open):{stores:[],checksum:hash('[]')};
    const byName=new Map(sources.files.map(f=>[f.name,f]));
    const get=(kind:'shuttle'|'runtime',collection:string,key:string)=>stores.stores.find(s=>s.kind===kind)?.documents.find(d=>d.collection===collection&&d.key===key)?.doc;
    const parts=new Map((stores.stores.find(s=>s.kind==='shuttle')?.documents??[]).filter(d=>d.collection==='channels').map(d=>[d.key,d.doc]));
    const effective=empty(),used=new Set<string>(),agents=new Set<string>(),routeOwners=new Map<string,string>(),peopleResolved=new Set<string>();
    const resolvePeople=(agent:string,fallback?:string)=>{
      if(peopleResolved.has(agent))return;
      if(!household.agents.includes(agent))return;
      const runtime=get('runtime','gates',agent),shuttle=get('shuttle','people',agent);
      if(runtime===undefined&&get('shuttle','moved',agent)!==undefined)throw Error();
      const selected=runtime??shuttle;
      if(selected!==undefined)projectBridgeDocument(effective,`accepted:${agent}`,'people',selected);
      else if(fallback!==undefined)effective.accounts.push(...inventory.accounts.filter(a=>a.source===fallback));
      peopleResolved.add(agent);
    };
    for(const instance of options.instances){
      for(const [kind,n]of Object.entries(instance)){if(byName.get(n)?.kind!==kind||used.has(n))throw Error();used.add(n);}
      const instanceConfig=inventory.instances.find(s=>s.source===instance.shuttle);
      if(!instanceConfig||agents.has(instanceConfig.agent)||!household.agents.includes(instanceConfig.agent))throw Error();agents.add(instanceConfig.agent);
      effective.instances.push(instanceConfig);
      resolvePeople(instanceConfig.agent,instance.people);
      const routes=acceptedRoutes(instanceConfig.agent,(c,k)=>get('shuttle',c,k),parts);
      if(routes!==undefined){projectBridgeDocument(effective,`accepted:${instanceConfig.agent}`,'routes',routes);routeOwners.set(`accepted:${instanceConfig.agent}`,instanceConfig.agent);}
      else{effective.routes.push(...inventory.routes.filter(r=>r.source===instance.routes));routeOwners.set(instance.routes,instanceConfig.agent);}
    }
    for(const f of sources.files)if(!f.kind.endsWith('-settings')&&!used.has(f.name))throw Error();
    // Every relevant accepted store agent participates, not only explicit instances.
    for(const store of stores.stores)for(const d of store.documents){
      if(store.kind==='runtime'&&d.collection==='gates'||store.kind==='shuttle'&&['people','moved','channels'].includes(d.collection))resolvePeople(d.key);
    }
    for(const agent of parts.keys()){
      if([...routeOwners.values()].includes(agent))continue;
      const resolved=acceptedRoutes(agent,(c,k)=>get('shuttle',c,k),parts);if(resolved===undefined)throw Error();
      projectBridgeDocument(effective,`accepted:${agent}`,'routes',resolved);routeOwners.set(`accepted:${agent}`,agent);
    }
    // Every declared legacy connection needs an explicit reviewed secret-name mapping.
    const required=new Set<string>();
    const localAgents=new Set(effective.instances.map(s=>s.agent));
    // Store-only snapshots have no explicit local roots; only household agents can run.
    const isLocal=(a:string)=>household.agents.includes(a)&&(!localAgents.size||localAgents.has(a));
    for(const s of effective.instances){if(s.discordSecret!==undefined)required.add(`${s.agent}:discord`);if(s.slackBundle!==undefined)required.add(`${s.agent}:slack`);}
    for(const s of inventory.settings)for(const a of Object.keys(s.bots).filter(isLocal))required.add(`${a}:${s.platform}`);
    for(const r of effective.routes)for(const a of Object.keys(r.bots).filter(isLocal))required.add(`${a}:discord`);
    // A reviewed mapping may explicitly include an off-machine household bot.
    for(const c of options.connections)if(c.platform==='discord'&&household.agents.includes(c.agent)&&effective.routes.some(r=>r.bots[c.agent]!==undefined))required.add(`${c.agent}:discord`);
    // Accepted parts carry each agent's own filters. Resolve every declared bot,
    // even when its instance has no legacy file fallback in this snapshot.
    for(const key of required){
      const [a,platform]=key.split(':');
      if(platform!=='discord'||[...routeOwners.values()].includes(a))continue;
      const resolved=acceptedRoutes(a,(c,k)=>get('shuttle',c,k),parts);if(resolved===undefined)continue;
      projectBridgeDocument(effective,`accepted:${a}`,'routes',resolved);routeOwners.set(`accepted:${a}`,a);
    }
    const venues:Venue[]=[],routes:Route[]=[],links:PersonLink[]=[];
    const incomplete:unknown[]=[];
    const retained:unknown[]=[];
    for(const c of options.connections){
      if(!household.agents.includes(c.agent)||!required.delete(`${c.agent}:${c.platform}`))throw Error();
      if(c.setupIncomplete){
        if(c.platform!=='slack'||c.bot!==undefined||c.tokenSecret!==undefined||c.appSecret!==undefined)throw Error();
        const config=effective.instances.find(s=>s.agent===c.agent);
        if(!config?.slackBundle||!Object.hasOwn(config.slackWorkspaces??{},c.workspace))throw Error();
        incomplete.push({agent:c.agent,platform:c.platform,workspace:c.workspace,bundle:config.slackBundle,reason:'setup incomplete: no split secret names or authenticated bot metadata'});
        continue;
      }
      if(!c.bot||!c.tokenSecret)throw Error();
      if(c.bot==='0'||c.workspace==='0'||(c.platform==='slack'&&(!c.appSecret||c.appSecret===c.tokenSecret)))throw Error();
      if(c.platform==='discord'){
        const claims=effective.routes.filter(r=>routeOwners.get(r.source)===c.agent&&r.bots[c.agent]!==undefined);
        if(!claims.length||claims.some(r=>r.bots[c.agent]!==c.bot||r.guild!==c.workspace))throw Error();
      }
      const configs=c.platform==='discord'?effective.routes.filter(r=>routeOwners.get(r.source)===c.agent&&r.guild===c.workspace&&r.bots[c.agent]===c.bot):[];
      const settings=configs.map(r=>({only:r.only,ignore:r.ignore,botRoles:r.botRoles[c.agent]??[]}));
      if(settings.some(r=>canonical(r)!==canonical(settings[0])))throw Error();
      venues.push(venueSchema.parse({...c,...settings[0],id:`legacy:${c.agent}:${c.platform}`,enabled:false}));
    }
    if(required.size)throw Error();
    for(const r of effective.routes){
      if(!r.guild){if(r.channels.length)throw Error();continue;}
      if(!venues.some(v=>v.platform==='discord'&&v.workspace===r.guild))throw Error();
      for(const c of r.channels){
        if(c.primary&&!household.agents.includes(c.primary)||c.readers.some(p=>!household.members.includes(p))){retained.push({kind:'route',source:r.source,channel:c.channel,reason:'audience is not projectable to this household'});continue;}
        const {thread,...fields}=c;
        if(thread){
          const parent=r.channels.find(p=>!p.thread&&p.channel===c.parent);
          if(!parent)throw Error();
          Object.assign(fields,{peer:parent.peer,pair:parent.pair,guest:parent.guest,readers:parent.readers});
        }
        if(fields.readers.some(p=>!household.members.includes(p))){retained.push({kind:'route',source:r.source,channel:c.channel,reason:'parent audience is not projectable to this household'});continue;}
        const record=routeSchema.parse({id:`legacy:discord:${r.guild}:${c.channel}`,platform:'discord',workspace:r.guild,...fields,notes:[]});
        // thread is source classification, not a setup field.
        routes.push(record);
      }
    }
    const agentClaims=effective.accounts.filter(a=>a.kind==='agent');
    for(const a of agentClaims){
      if(a.user==='0')throw Error();
      if(!household.agents.includes(a.owner)){retained.push({kind:'agent',source:a.source,owner:a.owner,reason:'not a household agent'});continue;}
      const samePlace=(b:typeof a)=>a.platform===b.platform&&(a.platform==='discord'||a.workspace===b.workspace);
      if(agentClaims.some(b=>samePlace(b)&&(b.owner===a.owner&&b.user!==a.user||b.user===a.user&&b.owner!==a.owner)))throw Error();
      const bots=venues.filter(v=>v.agent===a.owner&&v.platform===a.platform&&(a.platform==='discord'||v.workspace===a.workspace)).map(v=>v.bot);
      if(a.platform==='discord')bots.push(...effective.routes.flatMap(r=>r.bots[a.owner]===undefined?[]:[r.bots[a.owner]]));
      if(bots.some(bot=>bot!==a.user))throw Error();
    }
    for(const a of effective.accounts){
      if(a.kind!=='person')continue;
      if(venues.some(v=>v.platform===a.platform&&v.bot===a.user&&(a.platform==='discord'||v.workspace===a.workspace))||effective.routes.some(r=>a.platform==='discord'&&Object.values(r.bots).includes(a.user))||effective.accounts.some(b=>b.kind==='agent'&&b.platform===a.platform&&b.user===a.user&&(a.platform==='discord'||b.workspace===a.workspace)))throw Error();
      if(a.user==='0')throw Error();
      if(!household.members.includes(a.owner)){retained.push({kind:'person',source:a.source,owner:a.owner,reason:'not a household member'});continue;}
      const workspaces=a.platform==='slack'?[a.workspace!]:[...new Set(venues.filter(v=>v.platform==='discord').map(v=>v.workspace))];
      if(!workspaces.length){retained.push({kind:'person',source:a.source,owner:a.owner,reason:'no projectable workspace'});continue;}
      for(const workspace of workspaces)links.push(linkSchema.parse({id:`legacy:${a.platform}:${workspace}:${a.user}`,platform:a.platform,workspace,user:a.user,person:a.owner}));
    }
    const unique=<T extends{id:string}>(records:T[]):T[]=>{
      const out=new Map<string,T>();for(const r of records){const old=out.get(r.id);if(old&&canonical(old)!==canonical(r))throw Error();out.set(r.id,r);}return [...out.values()].sort((a,b)=>a.id<b.id?-1:1);
    };
    const expected={venues:unique(venues),routes:unique(routes),links:unique(links)};
    const evidence=JSON.stringify({inventory,stores,incomplete,retained}),mapping=canonical(options),checksum=hash(JSON.stringify([inventory.checksum,stores.checksum,mapping]));
    return {expected,evidence,mapping,checksum};
  }catch{throw Error('Invalid offline Bridges import mapping or sources');}
}
