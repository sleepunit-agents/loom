/** Prepared metadata in an agent's own source, never the shared database. */
import type {Database} from 'better-sqlite3';
import {commandSql as sql,schemaSql,cardSql,cardSchemaSql} from './semantic-schema-sql.js';
export function semanticCardsReady(db:Database){
 for(const name of ['memory_card_schema','memory_card_references'])if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))return false;
 const rows=db.prepare('SELECT number,sql FROM memory_card_schema ORDER BY number').all() as {number:number;sql:string}[];
 return rows.length===1&&rows[0].number===1&&rows[0].sql===cardSql;
}
export function semanticMemoryReady(db:Database){
 const table=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
 if(!table('memory_command_schema')||!table('memory_command_preparations')||!table('memory_command_receipts'))return false;
 const rows=db.prepare('SELECT number,sql FROM memory_command_schema ORDER BY number').all() as Array<{number:number;sql:string}>;
 return rows.length===1&&rows[0].number===1&&rows[0].sql===sql;
}
/** At each start, for a `memories.db` that was there before it (`prepareAgentMemory`). Each of the two
 * preparations has one step so far, so there is nothing to add yet: a file that records one is refused
 * unless it is this program's, and a file that never had one is left as it is (its commands are refused
 * one by one). A second step is added here. */
export function checkSemanticMemory(db:Database){
 const recorded=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
 if(recorded('memory_command_schema')&&!semanticMemoryReady(db))throw Error('Unknown semantic Memory preparation');
 if(recorded('memory_card_schema')&&!semanticCardsReady(db))throw Error('Unknown private card preparation');
}
/** Called while a fresh file is being made under its temporary name (`prepareAgentMemory`). */
export function prepareSemanticMemory(db:Database){
 db.transaction(()=>{
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_command_schema'").get())db.exec(schemaSql);
  const rows=db.prepare('SELECT number,sql FROM memory_command_schema ORDER BY number').all();
  if(rows.length){if(!semanticMemoryReady(db))throw Error('Unknown semantic Memory preparation');}
  else{db.exec(sql);db.prepare('INSERT INTO memory_command_schema (number,sql) VALUES(1,?)').run(sql);}
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_card_schema'").get())db.exec(cardSchemaSql);
  const cards=db.prepare('SELECT number,sql FROM memory_card_schema ORDER BY number').all();
  if(cards.length){if(!semanticCardsReady(db))throw Error('Unknown private card preparation');}
  else{db.exec(cardSql);db.prepare('INSERT INTO memory_card_schema (number,sql) VALUES(1,?)').run(cardSql);}
 }).immediate();
}
