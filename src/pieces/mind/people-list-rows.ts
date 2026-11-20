import type {Database} from 'better-sqlite3';
import type {PersonEvidence} from './people-model.js';

export function followPersonMerge(slug:string,next:(slug:string)=>string|undefined){
 const seen=new Set<string>();
 while(!seen.has(slug)&&seen.size<16){
  seen.add(slug);
  const target=next(slug);
  if(target===undefined)break;
  slug=target;
 }
 return slug;
}

export function batchPersonReferences(db:Database,slugs:string[]):string[]{
 const prefix='person:';
 const ids=slugs.filter(slug=>slug.startsWith(prefix)).map(slug=>slug.slice(prefix.length));
 if(!ids.length||!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_card_references'").get())return slugs;
 const rows=db.prepare("SELECT uuid,slug FROM memory_card_references WHERE kind='person' AND uuid IN (SELECT value FROM json_each(?))")
  .all(JSON.stringify(ids)) as {uuid:string;slug:string}[];
 const references=new Map(rows.map(row=>[prefix+row.uuid,row.slug]));
 return slugs.map(slug=>references.get(slug)??slug);
}

/** Follow only redirects reachable from this selection. The commons directory
 * may supply redirect metadata even when the viewer cannot open its cards. */
export function batchPersonMerges(db:Database,slugs:string[]):string[]{
 const rows=db.prepare(`WITH RECURSIVE reachable(slug,depth) AS (
  SELECT value,0 FROM json_each(?)
  UNION SELECT m.into_slug,r.depth+1 FROM reachable r JOIN person_merges m ON m.from_slug=r.slug WHERE r.depth<15
 ) SELECT DISTINCT from_slug,into_slug FROM person_merges WHERE from_slug IN (SELECT slug FROM reachable)`)
  .all(JSON.stringify(slugs)) as {from_slug:string;into_slug:string}[];
 const next=new Map(rows.map(row=>[row.from_slug,row.into_slug]));
 return slugs.map(slug=>followPersonMerge(slug,s=>next.get(s)));
}

/** Count all newer user memories, then return at most forty previews per person. */
export function batchPersonEvidence(db:Database,slugs:string[],now:number){
 const rows=db.prepare(`WITH ranked AS (
  SELECT p.slug,m.created,m.category,m.title,m.content,
   row_number() OVER (PARTITION BY p.slug ORDER BY m.created DESC,m.title,m.category,m.content) AS position,
   sum(CASE WHEN m.category='user' AND (p.synthesized_at IS NULL OR julianday(m.created)>julianday(p.synthesized_at)) THEN 1 ELSE 0 END)
    OVER (PARTITION BY p.slug) AS newer
  FROM memories m JOIN people p ON p.slug=json_extract(m.metadata,'$.person')
  WHERE typeof(json_extract(m.metadata,'$.person'))='text' AND p.slug IN (SELECT value FROM json_each(?)) AND p.archived_at IS NULL
   AND m.category IN ('user','feedback') AND m.archived=0 AND (m.expires_at IS NULL OR julianday(m.expires_at)>julianday(?))
 ) SELECT slug,created,category,title,content,newer FROM ranked WHERE position<=40 ORDER BY slug,position`)
  .all(JSON.stringify(slugs),new Date(now).toISOString()) as (PersonEvidence&{slug:string;newer:number})[];
 const bySlug=new Map<string,{evidence:PersonEvidence[];newer:number}>();
 for(const {slug,newer,...item} of rows){
  let group=bySlug.get(slug);
  if(!group){group={newer,evidence:[]};bySlug.set(slug,group);}
  group.evidence.push(item);
 }
 return bySlug;
}
