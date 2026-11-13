import { migrate, type Db } from './index.js';
type ExportRow=Record<string,unknown>;
type ExportFilter=(table:string,row:ExportRow)=>boolean;
const filters=new WeakMap<Db,Map<string,ExportFilter>>();
/** Owning pieces declare exclusions; core knows no piece's tables or record layout. */
export function registerExportFilter(db:Db,piece:string,filter:ExportFilter) {
 let held=filters.get(db);if(!held){held=new Map();filters.set(db,held);}held.set(piece,filter);
 migrate(db,'core_export',[{number:1,sql:'CREATE TABLE core_export_required (piece TEXT PRIMARY KEY)'}]);
 db.prepare('INSERT OR IGNORE INTO core_export_required VALUES (?)').run(piece);
}
/** Includes rendered retry copies and structured private scope, without returning words. */
export function privateExportCopy(value:unknown,ids:ReadonlySet<string>,field?:string):boolean {
 if(typeof value==='string') {
  // Only persisted JSON envelopes are decoded. Prompt/note/details strings
  // are words, even when their contents happen to look like JSON scope.
  if(['id','from','wake','approval'].includes(field??'') && ids.has(value))return true;
  if(['record','value','result'].includes(field??'')) {
   try{return privateExportCopy(JSON.parse(value),ids);}catch{return false;}
  }
  return false;
 }
 if(!value || typeof value!=='object')return false;
 if(!Array.isArray(value) && Object.hasOwn(value,'member') && (value as {member?:unknown}).member!==undefined)return true;
 return Object.entries(value).some(([key,v])=>privateExportCopy(v,ids,key));
}
/** Both export and backup use this snapshot, never copy loom.db. Comms and
 * private copies declared by owning pieces are intentionally unrecoverable.
 */
export function exportDatabase(db:Db) {
 return db.transaction(()=>{
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='core_export_required'").get()) {
   for(const {piece} of db.prepare('SELECT piece FROM core_export_required').all() as {piece:string}[])
    if(!filters.get(db)?.has(piece))throw new Error('Export requires the installed privacy filter for '+piece);
  }
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string}[];
  return tables.filter(t=>!t.name.startsWith('comms_')).map(t=>({
   ...t,rows:db.prepare(`SELECT * FROM "${t.name.replaceAll('"','""')}"`).all().filter(row=>
    (t.name!=='core_migrations'||(row as {piece:string}).piece!=='comms')
    && [...filters.get(db)?.values()??[]].every(filter=>filter(t.name,row as ExportRow))),
  }));
 })();
}
