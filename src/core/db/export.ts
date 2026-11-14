import { migrate, type Db } from './index.js';
type ExportRow=Record<string,unknown>;
type ExportFilter=(table:string,row:ExportRow)=>boolean;
const filters=new WeakMap<Db,Map<string,ExportFilter>>();
export interface SqliteRow { types: string[]; rowid?: bigint }
/** SQLite values include a numeric storage class and sometimes an implicit
 * identity that ordinary SELECT * JS rows cannot represent on their own. */
export function sqliteExportRows(db: Db, table: string): { rows: ExportRow[]; sqlite: SqliteRow[]; rowid?: string } {
 const quote=(name:string)=>`"${name.replaceAll('"','""')}"`;
 const columns=(db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all() as {name:string;hidden:number}[]).filter(c=>c.hidden!==1).map(c=>c.name);
 const info=(db.prepare('PRAGMA table_list').all() as {schema:string;name:string;wr:number}[]).find(t=>t.schema==='main'&&t.name===table);
 const rowid=info?.wr ? undefined : ['_rowid_','rowid','oid'].find(name=>!columns.some(c=>c.toLowerCase()===name));
 if(!info || !info.wr&&!rowid)throw Error('Database export cannot capture table identity');
 const raw=db.prepare(`SELECT *, ${columns.map(c=>`typeof(${quote(c)})`).join(',')}${rowid?`, ${quote(rowid)}`:''} FROM ${quote(table)}`).raw().safeIntegers().all() as unknown[][];
 const sqlite:SqliteRow[]=[];
 const rows=raw.map(values=>{
  const row:ExportRow=Object.fromEntries(columns.map((column,i)=>{
   const v=values[i];
   if(typeof v==='bigint' && (v>BigInt(Number.MAX_SAFE_INTEGER)||v<BigInt(Number.MIN_SAFE_INTEGER)))throw Error('Database export contains an unsupported number');
   return [column,typeof v==='bigint'?Number(v):v];
  }));
  sqlite.push({types:values.slice(columns.length,columns.length*2) as string[],...(rowid?{rowid:values[columns.length*2] as bigint}:{})});
  return row;
 });
 return {rows,sqlite,...(rowid?{rowid}:{})};
}
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
export function exportDatabase(db:Db, captureSqlite = false) {
 return db.transaction(()=>{
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='core_export_required'").get()) {
   for(const {piece} of db.prepare('SELECT piece FROM core_export_required').all() as {piece:string}[])
    if(!filters.get(db)?.has(piece))throw new Error('Export requires the installed privacy filter for '+piece);
  }
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string}[];
  return tables.filter(t=>!t.name.startsWith('comms_')).map(t=>{
   const captured=captureSqlite?sqliteExportRows(db,t.name):undefined;
   const input=captured?.rows??db.prepare(`SELECT * FROM "${t.name.replaceAll('"','""')}"`).all() as ExportRow[];
   const sqlite:SqliteRow[]=[];
   const rows=input.filter((row,i)=>{
    const keep=(t.name!=='core_migrations'||row.piece!=='comms') && [...filters.get(db)?.values()??[]].every(filter=>filter(t.name,row));
    if(keep&&captured)sqlite.push(captured.sqlite[i]);return keep;
   });
   return {...t,rows,...(captured?{sqlite,rowid:captured.rowid}:{})};
  });
 })();
}
