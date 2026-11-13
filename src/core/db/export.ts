import type { Db } from './index.js';
/** Both export and backup must use this table-by-table snapshot, never copy loom.db.
 * Comms is intentionally unrecoverable from a backup, including its import receipts.
 */
export function exportDatabase(db:Db) {
 return db.transaction(()=>{
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string}[];
  // Private Clock/Approvals rows can retain words from a Comms thread. Like
  // Comms they are omitted, including audit, metadata and retry-result copies.
  const privateIds=new Set<string>();
  for(const table of ['clock_wakes','clock_schedules','approvals_approvals','approvals_rules']) {
   if(!tables.some(t=>t.name===table))continue;
   for(const row of db.prepare(`SELECT id,record FROM ${table}`).all() as {id:string;record:string}[]) {
    if(JSON.parse(row.record).member!==undefined)privateIds.add(row.id);
   }
  }
  const privateCopy=(value:unknown):boolean=>{
   if(typeof value==='string') {
    if([...privateIds].some(id=>value.includes(id)))return true;
    try{return privateCopy(JSON.parse(value));}catch{return false;}
   }
   if(!value || typeof value!=='object')return false;
   if(!Array.isArray(value) && Object.hasOwn(value,'member') && (value as {member?:unknown}).member!==undefined)return true;
   return Object.values(value).some(privateCopy);
  };
  return tables.filter(t=>!t.name.startsWith('comms_')).map(t=>({
   ...t,rows:db.prepare(`SELECT * FROM "${t.name.replaceAll('"','""')}"`).all().filter(row=>{
    if(t.name==='core_migrations')return (row as {piece:string}).piece!=='comms';
    if(t.name.startsWith('clock_') || t.name.startsWith('approvals_'))return !privateCopy(row);
    if(t.name==='core_operations') {
     // Command results are rendered text and can lose structured member scope.
     const name=(row as {name:string}).name;
     return !['clock.command','approvals.command'].includes(name) && !privateCopy(row);
    }
    return true;
   }),
  }));
 })();
}
