/** Offline only. No normal operation reads the legacy snapshot. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { migrate, type Db } from '../../core/index.js';
import { changeSchema, repoId, attribute, type Attribution, type Project, type Change } from './model.js';
import { schema } from './schema.js';
import { canonical, loadChanges, replaceChanges } from './store.js';
export function projectFor(repo: string, projects: Project[]) {
 const found=projects.filter(p=>p.repos.some(r=>repoId(r)===repo));
 if(found.length>1) throw new Error('Repository belongs to more than one household project');
 return found[0]?.slug;
}
type ImportOptions = { projects: Project[]; attribution: Attribution; interrupt?: () => void };
export function importChanges(db: Db, from: string, settings: ImportOptions | (() => ImportOptions)) {
 const bytes=readFileSync(from), source=JSON.parse(bytes.toString()) as {v:number; changes:unknown[]};
 if(source.v!==1 || !Array.isArray(source.changes)) throw new Error('Expected a v1 Changes snapshot');
 const checksum=createHash('sha256').update(bytes).digest('hex');
 return db.transaction(()=>{
  migrate(db,'changes',schema);
  const old=db.prepare("SELECT value FROM changes_meta WHERE key='source-checksum'").get() as {value:string}|undefined;
  if(old) {if(old.value!==checksum) throw new Error('A different Changes source was already imported');return {ok:true,imported:false,checksum,changes:source.changes.length};}
 const options=typeof settings==='function'?settings():settings;
 // Preserve the source's normalized fields exactly; never trust its project attribution or task cache.
 const expected:Change[]=source.changes.map(raw=>{
  const c=changeSchema.parse(raw), repo=repoId(c.repo);
  if(c.repo!==repo || c.id!==`${repo}#${c.number}`) throw new Error('Invalid change identity');
  const project=projectFor(repo,options.projects);
  return {...attribute(c,options.attribution),...(project ? {project} : {})};
 }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 if(new Set(expected.map(c=>c.id)).size!==expected.length) throw new Error('Duplicate source change ids');
  if(loadChanges(db).length) throw new Error('Changes destination must be empty before import');
  replaceChanges(db,expected); options.interrupt?.();
  if(canonical(loadChanges(db))!==canonical(expected)) throw new Error('Changes import comparison failed: ids, counts or content differ');
  db.prepare("INSERT INTO changes_meta VALUES ('source-checksum',?)").run(checksum);
  return {ok:true,imported:true,checksum,changes:expected.length};
 })();
}
