/** Existing person cards, read in place. No schema initialization or path discovery. */
import { existsSync } from 'node:fs';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { maySee, mayAct, type Sharing, type Viewer } from '../../core/index.js';
import {resolveCardReference} from './card-references.js';
import type { PersonRecord, PersonCard, PersonEvidence } from './people-model.js';
import {MAX_REVISIONS} from '../../backends/cards.js';
export type { PersonRecord } from './people-model.js';
interface Row { slug: string; card_json: string; updated: string; synthesized_at: string | null; archived_at: string | null }
const has = (db: Database, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
export interface PeopleReaderOptions {
  projectHref?(agent:string,slug:string):string|undefined;
  directory?:string; agents:Array<{agent:string;memories:string}>; sharing():Sharing; now():number;
}
/** Direct file projection used by GraphQL. */
export interface PeopleReader {
 access(viewer:Viewer):{id:string;allowed:boolean;directory:boolean;agents:string[];canAdd:boolean};
 nextDeadline():number|undefined;
 read(id:string,viewer:Viewer):PersonRecord|undefined;
 ids(scope?:string):string[];
 sources:Map<string,Database>;
 allowed(viewer:Viewer,agent?:string):boolean;
 list(viewer:Viewer):PersonRecord[];
 history(id:string,viewer:Viewer):Array<{id:number;op:string;replacedAt:string;actor:string|null;card:PersonCard}>;
 close():void;
}
export const mayReadPerson=(viewer:Viewer,agent:string|undefined,sharing:Sharing)=>maySee(viewer,{type:'person',...(agent?{agent}:{})},sharing);
export function peopleReader(options:PeopleReaderOptions):PeopleReader {
  const sources = new Map<string, Database>(), failed=new Set<string>();
  for (const [id,path] of [['commons',options.directory], ...options.agents.map(a => [a.agent,a.memories])] as Array<[string,string | undefined]>) {
    try {if(path&&existsSync(path))sources.set(id,new BetterSqlite3(path,{readonly:true,fileMustExist:true,timeout:0}));}
    catch {failed.add(id);}
  }
  const allowed = (v:Viewer,agent?:string)=>mayReadPerson(v,agent,options.sharing());
  const available=(source:string)=>{if(failed.has(source))throw Error('People source unavailable');};
  function resolve(db: Database, slug: string) {
    if (!has(db,'person_merges')) return slug;
    const seen = new Set<string>();
    while (!seen.has(slug) && seen.size < 16) {
      seen.add(slug);
      const next = db.prepare('SELECT into_slug FROM person_merges WHERE from_slug=?').get(slug) as {into_slug:string} | undefined;
      if (!next) break;
      slug = next.into_slug;
    }
    return slug;
  }
  const read = (id: string, viewer: Viewer): PersonRecord | undefined => {
    const colon = id.indexOf(':'); if (colon < 1) return;
    const source = id.slice(0,colon), asked = id.slice(colon+1), agent = source === 'commons' ? undefined : source;
    if (!allowed(viewer,agent)) return;
    available(source);
    const db = sources.get(source); if (!db || !has(db,'people')) return;
    return db.transaction(() => {
      // Directory redirects also select the corresponding authorized relationship.
      const reference=agent?resolveCardReference(db,'person',asked):asked;
      let slug=reference;
      const directory=sources.get('commons');
      try {
        available('commons');
        slug=directory?resolve(directory,reference):reference;
        if(agent)slug=resolve(db,slug);
        if(agent&&directory&&has(directory,'people')) {const shared=directory.prepare('SELECT archived_at FROM people WHERE slug=?').get(slug) as {archived_at:string|null}|undefined;if(shared?.archived_at)return;}
      } catch(error) {if(allowed(viewer))throw error;slug=resolve(db,reference);}
      const row = db.prepare('SELECT slug,card_json,updated,synthesized_at,archived_at FROM people WHERE slug=? AND archived_at IS NULL').get(slug) as Row | undefined;
      if (!row) return;
      const card = JSON.parse(row.card_json) as PersonCard;
      const now = options.now(), nowIso = new Date(now).toISOString();
      let evidence: PersonEvidence[] = [], newer = 0;
      if (agent && maySee(viewer,{type:'memory',agent},options.sharing()) && has(db,'memories')) {
        evidence = db.prepare(`SELECT created,category,title,content FROM memories WHERE json_extract(metadata,'$.person')=? AND category IN ('user','feedback') AND archived=0 AND (expires_at IS NULL OR julianday(expires_at)>julianday(?)) ORDER BY created DESC LIMIT 40`).all(slug,nowIso) as PersonEvidence[];
        newer = (db.prepare(`SELECT count(*) AS n FROM memories WHERE json_extract(metadata,'$.person')=? AND category='user' AND archived=0 AND (expires_at IS NULL OR julianday(expires_at)>julianday(?)) AND (? IS NULL OR julianday(created)>julianday(?))`).get(slug,nowIso,row.synthesized_at,row.synthesized_at) as {n:number}).n;
      }
      const projects:PersonRecord['projects']=[];
      for(const [agentId,store] of sources) {
        if(agentId==='commons'||!allowed(viewer,agentId)||!maySee(viewer,{type:'project',agent:agentId},options.sharing())||!has(store,'projects')) continue;
        const rel=has(store,'people') ? store.prepare('SELECT card_json FROM people WHERE slug=? AND archived_at IS NULL').get(slug) as {card_json:string}|undefined : undefined;
        const where={...card.where,...(rel?(JSON.parse(rel.card_json) as PersonCard).where:{})};
        for(const project of store.prepare('SELECT card_json FROM projects WHERE archived_at IS NULL').all() as {card_json:string}[]) {
          const p=JSON.parse(project.card_json) as {slug:string;name:string;status:string;links:{aliases?:string[]}};
          if(agentId===slug || [p.slug,...(p.links.aliases??[])].some(key=>Object.hasOwn(where,key.replace(/-/g,'_')))) projects.push({agent:agentId,slug:p.slug,name:p.name,status:p.status,...(options.projectHref?.(agentId,p.slug)?{href:options.projectHref(agentId,p.slug)}:{})});
        }
      }
      const fields = Object.entries(card.where ?? {}).map(([key,field]) => ({ key, value: Array.isArray(field.value) ? field.value.join(', ') : String(field.value),...(field.label?{label:field.label}:{}),
        ...(field.source ? {source:field.source} : {}), ...(field.verified_at ? {verifiedAt:field.verified_at} : {}),
        state: !field.verified_at ? 'unverified' as const : now > Date.parse(field.verified_at)+(field.stale_after_days??14)*86400000 ? 'stale' as const : 'fresh' as const }));
      return { id,slug,...(agent ? {agent} : {}),name:card.name,card,updated:row.updated,synthesizedAt:row.synthesized_at,
        projects,...(!agent && Object.hasOwn(options.sharing().members,slug) ? {ownership:options.sharing().members[slug]}:{}),
        kind:card.how?.kind === 'agent' ? 'agent' as const : 'person' as const,evidence,newer,fields,...(slug !== reference ? {mergedFrom:reference} : {}) };
    })();
  };
  function sourceIds(source:string,db:Database) {
    return has(db,'people')?(db.prepare('SELECT slug FROM people WHERE archived_at IS NULL ORDER BY slug').all() as {slug:string}[]).map(r=>`${source}:${r.slug}`):[];
  }
  function ids(scope?:string) {
    if(scope!==undefined)return scope?[scope]:[];
    // The retiring Live transport asks for candidates without a viewer. A bad
    // source must not fail every subscriber; scoped reads still report errors.
    return [...sources].flatMap(([source,db])=>{try{return sourceIds(source,db);}catch{return [];}});
  }
  let closed=false;
  function nextDeadline():number|undefined {
    if(closed)return;
    const now=options.now();let next=Infinity;
    const add=(at:number)=>{if(Number.isFinite(at)&&at>now)next=Math.min(next,at);};
    for(const db of sources.values()){
      try{if(has(db,'people'))for(const raw of db.prepare('SELECT card_json FROM people WHERE archived_at IS NULL').iterate()){
        try{const card=JSON.parse((raw as {card_json:string}).card_json) as PersonCard;
          for(const field of Object.values(card.where??{}))if(field.verified_at)add(Date.parse(field.verified_at)+(field.stale_after_days??14)*86400000+1);
        }catch{/* Malformed cards remain explicit read errors, not timer inputs. */}
      }}catch{/* A failed source is reported by its reader. */}
      try{if(has(db,'memories'))for(const raw of db.prepare("SELECT expires_at,metadata FROM memories WHERE archived=0 AND category IN ('user','feedback') AND expires_at IS NOT NULL").iterate()){
        const row=raw as {expires_at:string;metadata:string|null};
        try{if(typeof JSON.parse(row.metadata??'{}').person==='string')add(Date.parse(row.expires_at));}catch{/* Invalid metadata has no person link. */}
      }}catch{/* A failed evidence source is reported by its reader. */}
    }
    return next===Infinity?undefined:next;
  }
  return {
    access(v){return {id:'people',allowed:allowed(v)||options.agents.some(a=>allowed(v,a.agent)),directory:allowed(v),
      agents:options.agents.filter(a=>allowed(v,a.agent)).map(a=>a.agent),canAdd:mayAct(v,{type:'person'},options.sharing(),'act','mind.personAdd')};},
    nextDeadline,read, ids, sources, allowed,
    list(viewer:Viewer) {
      for(const source of failed)if(allowed(viewer,source==='commons'?undefined:source))available(source);
      return [...sources].filter(([source])=>allowed(viewer,source==='commons'?undefined:source))
        .flatMap(([source,db])=>sourceIds(source,db).flatMap(id=>{const row=read(id,viewer);return row?[row]:[];}));
    },
    history(id:string,viewer:Viewer) {
      const person=read(id,viewer);if(!person)return [];
      const db=sources.get(person.agent??'commons');if(!db||!has(db,'person_revisions'))return [];
      return (db.prepare('SELECT id,op,replaced_at AS replacedAt,actor,snapshot_json FROM person_revisions WHERE slug=? ORDER BY id DESC LIMIT ?').all(person.slug,MAX_REVISIONS) as Array<{id:number;op:string;replacedAt:string;actor:string|null;snapshot_json:string}>).map(({snapshot_json,...row})=>({...row,card:(JSON.parse(snapshot_json) as {card:PersonCard}).card}));
    },
    close(){if(closed)return;closed=true;for(const db of sources.values())db.close();}
  };
}
