/** The shipped text of the command and card tables is compared byte for byte against every agent's file. */
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {commandSql,schemaSql,cardSql,cardSchemaSql} from './semantic-schema-sql.js';
import {prepareSemanticMemory,semanticMemoryReady,semanticCardsReady} from './semantic-schema.js';
it('keeps the shipped text unchanged, so a file prepared by any earlier build is still recognised',()=>{
 // A change here turns every existing agent's file away from commands. Add a numbered step instead.
 expect(createHash('sha256').update([commandSql,schemaSql,cardSql,cardSchemaSql].join('\0')).digest('hex')).toBe('3100866fde14bc8b7dd6dad0eeb9c13e740e5c6da6ef98ccfeabcf308d5715b2');
});
it('makes exactly the tables the text names, and recognises them',()=>{
 const db=new Database(':memory:');
 try{
  expect(semanticMemoryReady(db)).toBe(false);prepareSemanticMemory(db);
  expect(semanticMemoryReady(db)).toBe(true);expect(semanticCardsReady(db)).toBe(true);
  const tables=(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
  expect(tables).toEqual(['memory_card_references','memory_card_schema','memory_command_preparations','memory_command_receipts','memory_command_schema']);
  expect(db.prepare('SELECT sql FROM memory_command_schema').get()).toEqual({sql:commandSql});
  expect(db.prepare('SELECT sql FROM memory_card_schema').get()).toEqual({sql:cardSql});
  // Preparing again changes nothing.
  const before=db.serialize();prepareSemanticMemory(db);expect(db.serialize()).toEqual(before);
 }finally{db.close();}
});
