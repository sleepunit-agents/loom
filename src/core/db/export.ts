import type { Db } from './index.js';
/** Both export and backup must use this table-by-table snapshot, never copy loom.db.
 * Comms is intentionally unrecoverable from a backup, including its import receipts.
 */
export function exportDatabase(db:Db) {
 return db.transaction(()=>{
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string}[];
  return tables.filter(t=>!t.name.startsWith('comms_')).map(t=>({
   ...t,rows:db.prepare(`SELECT * FROM "${t.name.replaceAll('"','""')}"`).all().filter(row=>t.name!=='core_migrations'||(row as {piece:string}).piece!=='comms'),
  }));
 })();
}
