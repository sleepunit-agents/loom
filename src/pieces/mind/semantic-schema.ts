/** Prepared metadata in an agent's own source, never the shared database. */
import type {Database} from 'better-sqlite3';
const sql=`CREATE TABLE memory_command_preparations (
 viewer TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,input_hash TEXT NOT NULL,
 expires INTEGER NOT NULL,PRIMARY KEY(viewer,id));
CREATE TABLE memory_command_receipts (
 viewer TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,input_hash TEXT NOT NULL,
 result TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(viewer,id));`;
export function semanticMemoryReady(db:Database){
 const table=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
 if(!table('memory_command_schema')||!table('memory_command_preparations')||!table('memory_command_receipts'))return false;
 const rows=db.prepare('SELECT number,sql FROM memory_command_schema ORDER BY number').all() as Array<{number:number;sql:string}>;
 return rows.length===1&&rows[0].number===1&&rows[0].sql===sql;
}
/** Only exclusive fresh-file creation or the separate data move calls this. */
export function prepareSemanticMemory(db:Database){
 db.transaction(()=>{
  db.exec('CREATE TABLE IF NOT EXISTS memory_command_schema(number INTEGER PRIMARY KEY,sql TEXT NOT NULL)');
  const rows=db.prepare('SELECT number,sql FROM memory_command_schema ORDER BY number').all();
  if(rows.length){if(!semanticMemoryReady(db))throw Error('Unknown semantic Memory preparation');return;}
  db.exec(sql);db.prepare('INSERT INTO memory_command_schema VALUES(1,?)').run(sql);
 }).immediate();
}
