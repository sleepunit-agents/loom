/** Prepared metadata in an agent's own source, never the shared database. */
import type {Database} from 'better-sqlite3';
import {commandSql as sql,schemaSql} from './semantic-schema-sql.js';
export function semanticMemoryReady(db:Database){
 const table=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
 if(!table('memory_command_schema')||!table('memory_command_preparations')||!table('memory_command_receipts'))return false;
 const rows=db.prepare('SELECT number,sql FROM memory_command_schema ORDER BY number').all() as Array<{number:number;sql:string}>;
 return rows.length===1&&rows[0].number===1&&rows[0].sql===sql;
}
/** Only exclusive fresh-file creation or the separate data move calls this. */
export function prepareSemanticMemory(db:Database){
 db.transaction(()=>{
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_command_schema'").get())db.exec(schemaSql);
  const rows=db.prepare('SELECT number,sql FROM memory_command_schema ORDER BY number').all();
  if(rows.length){if(!semanticMemoryReady(db))throw Error('Unknown semantic Memory preparation');return;}
  db.exec(sql);db.prepare('INSERT INTO memory_command_schema VALUES(1,?)').run(sql);
 }).immediate();
}
