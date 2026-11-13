/** Existing person cards, read in place. No schema initialization or path discovery. */
import { existsSync } from 'node:fs';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { z } from 'zod';
import { operation, maySee, mayAct, type Operations, type Live, type Sharing, type Viewer } from '../../core/index.js';
import type { PeopleConversations } from './people-conversations.js';
import type { PersonRecord, PersonCard, PersonEvidence } from './people-model.js';
export type { PersonRecord } from './people-model.js';
interface Row { slug: string; card_json: string; updated: string; synthesized_at: string | null; archived_at: string | null }
const has = (db: Database, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
export function installMindPeople(operations: Operations, live: Live, options: {
  projectHref?(agent:string,slug:string):string|undefined; conversations?: PeopleConversations; directory?: string; agents: Array<{ agent: string; memories: string }>; sharing(): Sharing;
}) {
  const sources = new Map<string, Database>();
  try {
    for (const [id,path] of [['commons',options.directory], ...options.agents.map(a => [a.agent,a.memories])] as Array<[string,string | undefined]>) {
      if (path && existsSync(path)) sources.set(id, new BetterSqlite3(path, { readonly: true, fileMustExist: true, timeout: 0 }));
    }
  } catch (e) { for (const db of sources.values()) db.close(); throw e; }
  const allowed = (v: Viewer, agent?: string) => maySee(v, { type: 'person', ...(agent ? { agent } : {}) }, options.sharing());
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
    const db = sources.get(source); if (!db || !has(db,'people')) return;
    return db.transaction(() => {
      // Directory redirects also select the corresponding authorized relationship.
      const directory = sources.get('commons');
      const slug = directory ? resolve(directory,asked) : resolve(db,asked);
      if(agent && directory && has(directory,'people')) {const shared=directory.prepare('SELECT archived_at FROM people WHERE slug=?').get(slug) as {archived_at:string|null}|undefined;if(shared?.archived_at) return;}
      const row = db.prepare('SELECT slug,card_json,updated,synthesized_at,archived_at FROM people WHERE slug=? AND archived_at IS NULL').get(slug) as Row | undefined;
      if (!row) return;
      const card = JSON.parse(row.card_json) as PersonCard;
      const now = operations.clock.now(), nowIso = new Date(now).toISOString();
      let evidence: PersonEvidence[] = [], newer = 0;
      if (agent && maySee(viewer,{type:'memory',agent},options.sharing()) && has(db,'memories')) {
        evidence = db.prepare(`SELECT created,category,title,content FROM memories WHERE json_extract(metadata,'$.person')=? AND category IN ('user','feedback') AND archived=0 AND (expires_at IS NULL OR expires_at>?) ORDER BY created DESC LIMIT 40`).all(slug,nowIso) as PersonEvidence[];
        newer = (db.prepare(`SELECT count(*) AS n FROM memories WHERE json_extract(metadata,'$.person')=? AND category='user' AND archived=0 AND (expires_at IS NULL OR expires_at>?) AND (? IS NULL OR created>?)`).get(slug,nowIso,row.synthesized_at,row.synthesized_at) as {n:number}).n;
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
      const fields = Object.entries(card.where ?? {}).map(([key,field]) => ({ key, value: field.label ?? (Array.isArray(field.value) ? field.value.join(', ') : String(field.value)),
        ...(field.source ? {source:field.source} : {}), ...(field.verified_at ? {verifiedAt:field.verified_at} : {}),
        state: !field.verified_at ? 'unverified' as const : now > Date.parse(field.verified_at)+(field.stale_after_days??14)*86400000 ? 'stale' as const : 'fresh' as const }));
      return { id,slug,...(agent ? {agent} : {}),name:card.name,card,updated:row.updated,synthesizedAt:row.synthesized_at,
        projects,...(!agent && Object.hasOwn(options.sharing().members,slug) ? {ownership:options.sharing().members[slug]}:{}),
        kind:card.how?.kind === 'agent' ? 'agent' as const : 'person' as const,evidence,newer,fields,...(slug !== asked ? {mergedFrom:asked} : {}) };
    })();
  };
  function ids(scope?: string) {
    if (scope !== undefined) return scope ? [scope] : [];
    return [...sources].flatMap(([source,db]) => has(db,'people') ? (db.prepare('SELECT slug FROM people WHERE archived_at IS NULL ORDER BY slug').all() as {slug:string}[]).map(r => `${source}:${r.slug}`) : []);
  }
  operations.register(operation({ name:'mind.peopleList',input:z.object({}).strict(),output:z.unknown(),may:() => true,
    run:ctx => ids().flatMap(id => {const r=read(id,ctx.viewer);return r ? [r] : [];}) }));
  operations.register(operation({ name:'mind.personRead',input:z.object({id:z.string().min(3).max(200)}).strict(),output:z.unknown(),
    may:(v,input) => { const source=input.id.slice(0,input.id.indexOf(':'));return allowed(v,source==='commons' ? undefined : source); },
    run:(ctx,input) => read(input.id,ctx.viewer) ?? {ok:false,code:'not-found',message:'Person card not found'} }));
  live.register({name:'person',ids,read,inScope:(r,scope) => scope===undefined || r.id===scope,
    refreshOn:c => c.type==='person' || c.type==='memory' || c.type==='project',
    expires(record) {
      const r=record as unknown as PersonRecord, now=operations.clock.now();
      const deadlines=Object.values(r.card.where ?? {}).flatMap(f => f.verified_at ? [Date.parse(f.verified_at)+(f.stale_after_days??14)*86400000+1] : []);
      const db=r.agent && sources.get(r.agent);
      if (db && has(db,'memories')) {
        const next=db.prepare(`SELECT min(expires_at) AS at FROM memories WHERE archived=0 AND json_extract(metadata,'$.person')=? AND expires_at>?`).get(r.slug,new Date(now).toISOString()) as {at:string|null};
        if (next.at) deadlines.push(Date.parse(next.at));
      }
      return deadlines.filter(t => t>now).sort((a,b)=>a-b)[0];
    },
  });
  live.register({name:'people.conversations',ids,read:(id,v)=>{const person=read(id,v);return person ? {id,...(options.conversations?.list(v,person.slug) ?? {available:false,rows:[]})} : undefined;},inScope:(r,scope)=>scope===undefined || r.id===scope,refreshOn:c=>c.type==='person' || c.type==='attention.conversation' || c.type.startsWith('comms.')});
  live.register({name:'people.access',ids:()=>['people'],read:(_id,v)=>({id:'people',allowed:allowed(v)||options.agents.some(a=>allowed(v,a.agent)),directory:allowed(v),
    agents:options.agents.filter(a=>allowed(v,a.agent)).map(a=>a.agent),
    canAdd:mayAct(v,{type:'person'},options.sharing(),'act','mind.personAdd')}),inScope:()=>true});
  return {close(){for(const db of sources.values()) db.close();}};
}
