import {evidenceExpiry,personEvidenceRows} from '../../backends/people.js';
import {accountColumns,accountHolders,listAccountSightings,slackGrantDirectory,approvedSlackRecipient,type AccountPlatform} from '../../backends/people-accounts.js';
/** Existing person cards, read in place. No schema initialization or path discovery. */
import { existsSync } from 'node:fs';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { AgentFiles } from './sources.js';
import { isHouseholdOwner } from '../../policy.js';
import { maySee, mayAct, type Sharing, type Viewer } from '../../core/index.js';
import {batchPersonEvidence,batchPersonMerges,batchPersonReferences,followPersonMerge} from './people-list-rows.js';
import {resolveCardReference} from './card-references.js';
import type { PersonRecord, PersonCard, PersonEvidence, AccountSighting } from './people-model.js';
import {MAX_REVISIONS,fieldState,freshUntil} from '../../backends/cards.js';
export type { PersonRecord } from './people-model.js';
interface Row { slug: string; card_json: string; updated: string; synthesized_at: string | null; archived_at: string | null }
const has = (db: Database, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
export interface PeopleReaderOptions {
  projectHref?(agent:string,slug:string):string|undefined;
  directory?:string; defaultAgent?():string|undefined; agents:Array<{agent:string;memories:string}>; sharing():Sharing; now():number;
}
/** Direct file projection used by GraphQL. */
export interface PeopleReader {
 access(viewer:Viewer):{id:string;allowed:boolean;directory:boolean;agents:string[];canAdd:boolean};
 outsideAccount(viewer:Viewer,slug:string,platform:AccountPlatform):{workspace:string;user:string}|undefined;
 outsideName(viewer:Viewer, platform:AccountPlatform, workspace:string, user:string):string|undefined;
 slackGrantNames(viewer:Viewer,accounts:{workspace:string;user:string}[]):ReturnType<typeof slackGrantDirectory>;
 slackRecipient(viewer:Viewer,workspace:string,user:string):string|undefined;
 sightings(viewer:Viewer,slug:string):AccountSighting[];
 ownEvidence(viewer:Viewer,slug:string,since:string|null):PersonEvidence[]|null;
 nextDeadline():number|undefined;
 read(id:string,viewer:Viewer):PersonRecord|undefined;
 ids(scope?:string):string[];
 sources:Map<string,Database>;
 allowed(viewer:Viewer,agent?:string):boolean;
 /** `sharing`: the facts a caller read itself earlier in the same synchronous call (a listing of projects lists
  * the people too), so that one call reads them once. Never facts kept from an earlier call. */
 list(viewer:Viewer,sharing?:Sharing):PersonRecord[];
 history(id:string,viewer:Viewer):Array<{id:number;op:string;replacedAt:string;actor:string|null;card:PersonCard}>;
 close():void;
}
export function mayAddPerson(viewer:Viewer,agent:string|undefined,sharing:Sharing){
  return !!agent && mayAct(viewer,{type:'person'},sharing,'act') && mayAct(viewer,{type:'person',agent},sharing,'act');
}
export const mayReadPerson=(viewer:Viewer,agent:string|undefined,sharing:Sharing)=>maySee(viewer,{type:'person',...(agent?{agent}:{})},sharing);
export function peopleReader(options:PeopleReaderOptions):PeopleReader {
  const failed=new Set<string>();
  const open=(id:string,path:string|undefined)=>{
    try {if(path&&existsSync(path))return new BetterSqlite3(path,{readonly:true,fileMustExist:true,timeout:0});}
    catch {failed.add(id);}
    return undefined;
  };
  // The directory first, then each agent's file as the list of agents has it now.
  const sources = new AgentFiles<{agent:string;memories:string},Database>(()=>options.agents,a=>open(a.agent,a.memories));
  const commons=open('commons',options.directory);if(commons)sources.set('commons',commons);
  sources.follow();
  // One listing reads many people, and each read asks who may see what several times over. The household's
  // sharing facts are a read of whole tables, and nothing in a listing writes, so a listing reads them once and
  // parses each agent's projects once (`held`). A single read outside a listing asks afresh every time.
  interface ProjectCard {slug:string;name:string;status:string;links:{aliases?:string[]}}
  interface ProjectSource {agent:string;cards:ProjectCard[];relationship:(slug:string)=>string|undefined}
  interface Held {viewer:Viewer;sharing:Sharing;stores:Map<string,Database>;projectSources?:ProjectSource[];tables:Map<Database,Map<string,boolean>>}
  let held:Held|undefined;
  const sharing=()=>held?.sharing??options.sharing();
  const allowed = (v:Viewer,agent?:string)=>mayReadPerson(v,agent,sharing());
  const stores=()=>held?.stores??sources;
  function hasTable(db:Database,name:string){
    if(!held)return has(db,name);
    let tables=held.tables.get(db);
    if(!tables){tables=new Map();held.tables.set(db,tables);}
    let exists=tables.get(name);
    if(exists===undefined){exists=has(db,name);tables.set(name,exists);}
    return exists;
  }
  function projectSources(viewer:Viewer):ProjectSource[]{
    const listing=held?.viewer===viewer?held:undefined;
    if(listing?.projectSources)return listing.projectSources;
    const result:ProjectSource[]=[];
    for(const [agent,db] of stores()){
      if(agent==='commons'||!allowed(viewer,agent)||!maySee(viewer,{type:'project',agent},sharing())||!hasTable(db,'projects'))continue;
      const cards=(db.prepare('SELECT card_json FROM projects WHERE archived_at IS NULL').all() as {card_json:string}[]).map(row=>JSON.parse(row.card_json) as ProjectCard);
      let relationship:ProjectSource['relationship']=()=>undefined;
      if(hasTable(db,'people')){
        if(listing){
          const rows=db.prepare('SELECT slug,card_json FROM people WHERE archived_at IS NULL').all() as {slug:string;card_json:string}[];
          const bySlug=new Map(rows.map(row=>[row.slug,row.card_json]));
          relationship=slug=>bySlug.get(slug);
        }else{
          const statement=db.prepare('SELECT card_json FROM people WHERE slug=? AND archived_at IS NULL');
          relationship=slug=>(statement.get(slug) as {card_json:string}|undefined)?.card_json;
        }
      }
      result.push({agent,cards,relationship});
    }
    if(listing)listing.projectSources=result;
    return result;
  }
  const available=(source:string)=>{if(failed.has(source))throw Error('People source unavailable');};
  function resolve(db: Database, slug: string) {
    if (!hasTable(db,'person_merges')) return slug;
    const statement=db.prepare('SELECT into_slug FROM person_merges WHERE from_slug=?');
    return followPersonMerge(slug,s=>(statement.get(s) as {into_slug:string}|undefined)?.into_slug);
  }
  const read = (id: string, viewer: Viewer): PersonRecord | undefined => {
    const colon = id.indexOf(':'); if (colon < 1) return;
    const source = id.slice(0,colon), asked = id.slice(colon+1), agent = source === 'commons' ? undefined : source;
    if (!allowed(viewer,agent)) return;
    available(source);
    const db = stores().get(source); if (!db || !hasTable(db,'people')) return;
    return db.transaction(() => {
      // Directory redirects also select the corresponding authorized relationship.
      const reference=agent?resolveCardReference(db,'person',asked):asked;
      let slug=reference;
      const directory=stores().get('commons');
      try {
        available('commons');
        slug=directory?resolve(directory,reference):reference;
        if(agent)slug=resolve(db,slug);
        if(agent&&directory&&hasTable(directory,'people')) {const shared=directory.prepare('SELECT archived_at FROM people WHERE slug=?').get(slug) as {archived_at:string|null}|undefined;if(shared?.archived_at)return;}
      } catch(error) {if(allowed(viewer))throw error;slug=resolve(db,reference);}
      const row = db.prepare('SELECT slug,card_json,updated,synthesized_at,archived_at FROM people WHERE slug=? AND archived_at IS NULL').get(slug) as Row | undefined;
      if (!row) return;
      const now = options.now(), nowIso = new Date(now).toISOString();
      let evidence: PersonEvidence[] = [], newer = 0;
      if (agent && maySee(viewer,{type:'memory',agent},sharing()) && hasTable(db,'memories')) {
        evidence = db.prepare(`SELECT created,category,title,content FROM memories WHERE json_extract(metadata,'$.person')=? AND category IN ('user','feedback') AND archived=0 AND (expires_at IS NULL OR julianday(expires_at)>julianday(?)) ORDER BY created DESC,title,category,content LIMIT 40`).all(slug,nowIso) as PersonEvidence[];
        newer = (db.prepare(`SELECT count(*) AS n FROM memories WHERE json_extract(metadata,'$.person')=? AND category='user' AND archived=0 AND (expires_at IS NULL OR julianday(expires_at)>julianday(?)) AND (? IS NULL OR julianday(created)>julianday(?))`).get(slug,nowIso,row.synthesized_at,row.synthesized_at) as {n:number}).n;
      }
      return personRecord(id,reference,agent,row,viewer,now,evidence,newer);
    })();
  };
  function personRecord(id:string,reference:string,agent:string|undefined,row:Row,viewer:Viewer,now:number,evidence:PersonEvidence[],newer:number):PersonRecord {
    const slug=row.slug, card=JSON.parse(row.card_json) as PersonCard;
    const projects:PersonRecord['projects']=[];
    for(const {agent:agentId,cards,relationship} of projectSources(viewer)) {
      const rel=relationship(slug);
      const where={...card.where,...(rel?(JSON.parse(rel) as PersonCard).where:{})};
      for(const p of cards) {
        if(agentId===slug || [p.slug,...(p.links.aliases??[])].some(key=>Object.hasOwn(where,key.replace(/-/g,'_')))) projects.push({agent:agentId,slug:p.slug,name:p.name,status:p.status,...(options.projectHref?.(agentId,p.slug)?{href:options.projectHref(agentId,p.slug)}:{})});
      }
    }
    const fields = Object.entries(card.where ?? {}).map(([key,field]) => ({ key, value: Array.isArray(field.value) ? field.value.join(', ') : String(field.value),...(field.label?{label:field.label}:{}),
      ...(field.source ? {source:field.source} : {}), ...(field.verified_at ? {verifiedAt:field.verified_at} : {}),
      state: ({ok:'fresh',stale:'stale',unverified:'unverified'} as const)[fieldState(field,now).kind] }));
    return { id,slug,...(agent ? {agent} : {}),name:card.name,card,updated:row.updated,synthesizedAt:row.synthesized_at,
      projects,...(!agent && Object.hasOwn(sharing().members,slug) ? {ownership:sharing().members[slug]}:{}),
      kind:card.how?.kind === 'agent' ? 'agent' as const : 'person' as const,evidence,newer,fields,...(slug !== reference ? {mergedFrom:reference} : {}) };
  }
  function listSource(source:string,db:Database,viewer:Viewer,now:number):PersonRecord[]{
    if(!hasTable(db,'people'))return [];
    const rows=db.prepare('SELECT slug,card_json,updated,synthesized_at,archived_at FROM people WHERE archived_at IS NULL ORDER BY slug').all() as Row[];
    if(!rows.length)return [];
    const agent=source==='commons'?undefined:source;
    const bySlug=new Map(rows.map(row=>[row.slug,row]));
    const asked=rows.map(row=>row.slug);
    const references=agent?batchPersonReferences(db,asked):asked;
    const merged=(db:Database,slugs:string[])=>hasTable(db,'person_merges')?batchPersonMerges(db,slugs):slugs;
    let slugs=references;
    let archived=new Set<string>();
    try {
      available('commons');
      const directory=stores().get('commons');
      if(directory)slugs=merged(directory,slugs);
      if(agent)slugs=merged(db,slugs);
      if(agent&&directory&&hasTable(directory,'people')){
        const retired=directory.prepare("SELECT slug FROM people WHERE archived_at IS NOT NULL AND archived_at<>'' AND slug IN (SELECT value FROM json_each(?))").all(JSON.stringify(slugs)) as {slug:string}[];
        archived=new Set(retired.map(row=>row.slug));
      }
    }catch(error){if(allowed(viewer))throw error;slugs=merged(db,references);}
    const visible=[...new Set(slugs.filter(slug=>bySlug.has(slug)&&!archived.has(slug)))];
    if(!visible.length)return [];
    const evidence=agent&&maySee(viewer,{type:'memory',agent},sharing())&&hasTable(db,'memories')?batchPersonEvidence(db,visible,now):undefined;
    return rows.flatMap((asked,i)=>{
      const slug=slugs[i]!,row=bySlug.get(slug);
      if(!row||archived.has(slug))return [];
      const group=evidence?.get(slug);
      return [personRecord(source+':'+asked.slug,references[i]!,agent,row,viewer,now,group?.evidence??[],group?.newer??0)];
    });
  }
  function sourceIds(source:string,db:Database) {
    return hasTable(db,'people')?(db.prepare('SELECT slug FROM people WHERE archived_at IS NULL ORDER BY slug').all() as {slug:string}[]).map(r=>`${source}:${r.slug}`):[];
  }
  function ids(scope?:string) {
    if(scope!==undefined)return scope?[scope]:[];
    // The retiring Live transport asks for candidates without a viewer. A bad
    // source must not fail every subscriber; scoped reads still report errors.
    return [...sources].flatMap(([source,db])=>{try{return sourceIds(source,db);}catch{return [];}});
  }
  let closed=false;
  // Each connection is read-only. SQLite changes its data_version when another connection commits.
  // Keep only the next timestamp, never the underlying cards or evidence.
  const deadlines=new WeakMap<Database,{version:number;measuredAt:number;next:number}>();
  function nextDeadline():number|undefined {
    if(closed)return;
    const now=options.now();let next=Infinity;
    for(const db of sources.values()){
      let version:number|undefined;
      try{if(db.readonly&&!db.inTransaction)version=db.pragma('data_version',{simple:true}) as number;}catch{/* Try reading both sources below. */}
      const cached=deadlines.get(db);
      if(cached&&cached.version===version&&cached.measuredAt<=now&&now<cached.next){
        next=Math.min(next,cached.next);continue;
      }
      let sourceNext=Infinity,complete=true;
      const add=(at:number)=>{if(Number.isFinite(at)&&at>now)sourceNext=Math.min(sourceNext,at);};
      try{if(has(db,'people'))for(const raw of db.prepare('SELECT card_json FROM people WHERE archived_at IS NULL').iterate()){
        try{const card=JSON.parse((raw as {card_json:string}).card_json) as PersonCard;
          for(const field of Object.values(card.where??{}))add((freshUntil(field)??NaN)+1);
        }catch{/* Malformed cards remain explicit read errors, not timer inputs. */}
      }}catch{complete=false;}
      try{if(has(db,'memories'))for(const raw of db.prepare("SELECT expires_at,metadata FROM memories WHERE archived=0 AND category IN ('user','feedback') AND expires_at IS NOT NULL").iterate()){
        const row=raw as {expires_at:string;metadata:string|null};
        try{if(typeof JSON.parse(row.metadata??'{}').person==='string')add(evidenceExpiry(row.expires_at));}catch{/* Invalid metadata has no person link. */}
      }}catch{complete=false;}
      if(complete&&version!==undefined)deadlines.set(db,{version,measuredAt:now,next:sourceNext});
      else deadlines.delete(db);
      next=Math.min(next,sourceNext);
    }
    return next===Infinity?undefined:next;
  }
  return {
    access(viewer){
      const current=options.sharing(),directory=mayReadPerson(viewer,undefined,current);
      const authorized=options.agents.filter(({agent})=>mayReadPerson(viewer,agent,current));
      return {id:'people',allowed:directory||authorized.length>0,directory,
        agents:authorized.map(row=>row.agent).filter(id=>!current.agents||current.agents.includes(id)),
        get canAdd(){return mayAddPerson(viewer,options.defaultAgent?.(),current);}};
    },
    sightings(viewer,slug) {
      const db=sources.get('commons');
      if(!allowed(viewer)||!db||!hasTable(db,'person_account_sightings'))return [];
      return db.transaction(()=>listAccountSightings(db,slug))();
    },
    outsideAccount(viewer,slug,platform){
      const [space,account]=accountColumns(platform);
      const visible:string[]=[];
      if(allowed(viewer))visible.push('commons');
      if(viewer.kind==='agent'&&allowed(viewer,viewer.id))visible.push(viewer.id);
      let result:{workspace:string;user:string}|undefined;
      for(const source of visible){
        const db=sources.get(source);if(!db||!hasTable(db,'people'))continue;
        const row=db.prepare(`SELECT ${space} AS workspace, ${account} AS user, json_type(card_json, '$.where.${platform}.value') AS kind FROM people WHERE slug=? AND archived_at IS NULL AND json_valid(card_json)`)
          .get(resolve(db,slug)) as {workspace:unknown;user:unknown;kind:string|null}|undefined;
        if(!row||row.workspace===null&&row.user===null)continue;
        if(row.kind!=='text'||typeof row.workspace!=='string'||typeof row.user!=='string')return;
        const matches=accountHolders(db,platform,row.workspace,row.user);
        if(matches.length!==1||result&&(result.workspace!==row.workspace||result.user!==row.user))return;
        result={workspace:row.workspace,user:row.user};
      }
      return result;
    },
    outsideName(viewer,platform,workspace,user) {
      if (!allowed(viewer)) return;
      const db=sources.get('commons');
      if(!db) return;
      try {
        const matches=accountHolders(db,platform,workspace,user);
        return matches.length===1 ? matches[0]?.name : undefined;
      } catch { return undefined; } // An unavailable directory cannot supply a held name.
    },
    slackGrantNames(viewer,accounts){
      const db=sources.get('commons'),policy=sharing();
      if(!db||!isHouseholdOwner(viewer,policy)||!mayReadPerson(viewer,undefined,policy))return new Map();
      return db.transaction(()=>slackGrantDirectory(db,accounts))();
    },
    slackRecipient(viewer,workspace,user) {
      const db=sources.get('commons');
      if (!db || !isHouseholdOwner(viewer, sharing())) return;
      try {
        return db.transaction(() => {
          return approvedSlackRecipient(db,workspace,user);
        })();
      } catch { return undefined; }
    },
    ownEvidence(viewer,slug,since) {
      if (viewer.kind !== 'agent' || viewer.id === 'commons' || !maySee(viewer,{type:'memory',agent:viewer.id},sharing())) return null;
      const db = sources.get(viewer.id);
      available(viewer.id);
      return db ? personEvidenceRows(db,slug,since,options.now()) : null;
    },
    nextDeadline,read, ids, sources, allowed,
    list(viewer:Viewer,given?:Sharing) {
      // Synchronous from here to the end: no write of this program can fall inside it.
      const outer=held;held={viewer,sharing:given??options.sharing(),stores:new Map(sources),tables:new Map()};
      try {
        for(const source of failed)if(allowed(viewer,source==='commons'?undefined:source))available(source);
        const now=options.now();
        return [...held.stores].filter(([source])=>allowed(viewer,source==='commons'?undefined:source))
          .flatMap(([source,db])=>db.transaction(()=>listSource(source,db,viewer,now))());
      } finally {held=outer;}
    },
    history(id:string,viewer:Viewer) {
      const person=read(id,viewer);if(!person)return [];
      const db=sources.get(person.agent??'commons');if(!db||!has(db,'person_revisions'))return [];
      return (db.prepare('SELECT id,op,replaced_at AS replacedAt,actor,snapshot_json FROM person_revisions WHERE slug=? ORDER BY id DESC LIMIT ?').all(person.slug,MAX_REVISIONS) as Array<{id:number;op:string;replacedAt:string;actor:string|null;snapshot_json:string}>).map(({snapshot_json,...row})=>({...row,card:(JSON.parse(snapshot_json) as {card:PersonCard}).card}));
    },
    close(){if(closed)return;closed=true;for(const db of sources.end())db.close();}
  };
}
