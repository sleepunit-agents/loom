import type {Database} from 'better-sqlite3';
import {heatColumns, heatOf, type HeatInput} from '../../backends/salience.js';
import type {ProjectQuery} from './projects-roles.js';
import type {ProjectItem, ProjectSection} from './projects-model.js';

export const activeMemory = 'archived=0 AND (expires_at IS NULL OR julianday(expires_at)>julianday(?))';

// This function belongs to the reader's private SQLite connection. Rank metadata
// first so the store only returns the words of the selected previews.
export function registerProjectHeat(db:Database) {
 db.function('project_memory_heat', {deterministic:true,directOnly:true}, (
  category:HeatInput['category'], created:string, authored:string|null, recall:number|null,
  recalled:string|null, sourcing:string|null, confidence:number|null, observed:string|null, now:number,
 )=>heatOf({category,created,updated:null,authored_at:authored,recall_heat:recall,
  recall_heat_at:recalled,sourcing,confidence,observed_at:observed},now));
}

type Summary = {slug:string;category:string;n:number;activity:string;expiry:string|null};
type Preview = {slug:string;ref:string;category:string;title:string;content:string;created:string;updated:string|null};

export function projectMemorySections(db:Database, agent:string, queries:ProjectQuery[]):Map<string,ProjectSection> {
 const result = new Map<string,ProjectSection & {counts:Record<string,number>;total:number;items:ProjectItem[]}>();
 if (!queries.length) return result;
 const now = queries[0]!.now;
 const names = JSON.stringify(queries.flatMap(q=>[...new Set(q.names)].map(name=>[q.card.slug,name])));
 // A typed materialized name column lets SQLite index the join on legacy stores without a project index.
 const selection = `WITH names(slug,name) AS MATERIALIZED (
  SELECT value->>0,CAST(value->>1 AS TEXT) FROM json_each(?)
 ), selected AS (
  SELECT names.slug, m.id, m.category, m.expires_at, ${heatColumns(db)}
  FROM names JOIN memories m ON m.project=names.name WHERE ${activeMemory}
 )`;
 const args = [names,new Date(now).toISOString()];
 const summaries = db.prepare(`${selection}, dated AS (
  SELECT *,max(coalesce(updated,created)) OVER (PARTITION BY slug) AS activity,
   first_value(expires_at) OVER (PARTITION BY slug ORDER BY julianday(expires_at) NULLS LAST,expires_at) AS expiry
  FROM selected
 ) SELECT slug,category,count(*) AS n,activity,expiry FROM dated GROUP BY slug,category ORDER BY slug,category`).all(...args) as Summary[];
 const previews = db.prepare(`${selection}, ranked AS (
  SELECT slug,id,row_number() OVER (PARTITION BY slug ORDER BY created DESC,id DESC) AS recent,
   row_number() OVER (PARTITION BY slug ORDER BY
    project_memory_heat(category,created,authored_at,recall_heat,recall_heat_at,sourcing,confidence,observed_at,?) DESC,created DESC,id DESC) AS hot
  FROM selected
 ), previews AS (
  SELECT slug,id,0 AS batch,recent AS position FROM ranked WHERE recent<=20
  UNION ALL SELECT slug,id,1,id FROM ranked WHERE hot<=10
 ) SELECT p.slug,m.ref,m.category,m.title,m.content,m.created,m.updated
 FROM previews p JOIN memories m ON m.id=p.id ORDER BY p.slug,p.batch,p.position`).all(...args,now) as Preview[];
 const bySlug = new Map(queries.map(q=>[q.card.slug,q]));
 const items = new Map<string,Map<string,ProjectItem>>();
 for (const q of queries) {
  result.set(q.card.slug,{key:'memories',label:'Memories',available:true,counts:Object.create(null),total:0,items:[]});
  items.set(q.card.slug,new Map());
 }
 for (const row of summaries) {
  const section = result.get(row.slug)!;
  section.counts[row.category]=row.n;
  section.total += row.n;
  if (row.activity) section.activity=row.activity;
  if (row.expiry) section.expires=Date.parse(row.expiry);
 }
 for (const row of previews) {
  const changed = row.updated??row.created;
  items.get(row.slug)!.set(row.ref,{
   title:`${row.title} — ${row.content}`.replace(/\s+/g,' ').slice(0,200),
   href:`/p/work/notes/project/${encodeURIComponent(agent+':'+row.slug)}/memory/${encodeURIComponent(row.ref)}`,
   ref:row.ref,when:row.created,changed,status:row.category,new:Date.parse(changed)>Date.parse(bySlug.get(row.slug)!.since),
  });
 }
 for (const [slug,refs] of items) result.get(slug)!.items=[...refs.values()].sort((a,b)=>Date.parse(b.when!)-Date.parse(a.when!));
 return result;
}
