import {expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {opaqueCardReference,resolveCardReference} from './card-references.js';
import {prepareSemanticMemory,semanticMemoryReady,semanticCardsReady} from './semantic-schema.js';
import {commandSql,schemaSql} from './semantic-schema-sql.js';
it('keeps stable typed opaque references private and resolves them through a read-only source',()=>{
 const home=mkdtempSync(join(tmpdir(),'private-card-refs-')),path=join(home,'fiction.db'),db=new Database(path);
 try{
  prepareSemanticMemory(db);let person='',project='';
  expect(()=>opaqueCardReference(db,'person','private-target')).toThrow('requires its source transaction');
  db.transaction(()=>{person=opaqueCardReference(db,'person','private-target');project=opaqueCardReference(db,'project','private-target');expect(opaqueCardReference(db,'person','private-target')).toBe(person);}).immediate();
  expect(person).toMatch(/^person:[a-f0-9-]{36}$/);expect(project).toMatch(/^project:[a-f0-9-]{36}$/);expect(person+project).not.toContain('private-target');
  const reader=new Database(path,{readonly:true,fileMustExist:true});
  try{const before=reader.serialize();expect(resolveCardReference(reader,'person',person)).toBe('private-target');expect(resolveCardReference(reader,'project',project)).toBe('private-target');expect(resolveCardReference(reader,'project',person)).toBe(person);expect(reader.serialize()).toEqual(before);}finally{reader.close();}
  expect(db.prepare('SELECT count(*) AS n FROM memory_card_references').get()).toEqual({n:2});
 }finally{db.close();rmSync(home,{recursive:true,force:true});}
});
it('preserves semantic-only preparation and only appends card preparation when explicitly requested',()=>{
 const db=new Database(':memory:');
 try{
  db.exec(schemaSql+commandSql);db.prepare('INSERT INTO memory_command_schema VALUES(1,?)').run(commandSql);const before=db.serialize();
  expect(semanticMemoryReady(db)).toBe(true);expect(semanticCardsReady(db)).toBe(false);expect(resolveCardReference(db,'person','friend')).toBe('friend');expect(resolveCardReference(db,'person','person:unknown')).toBe('person:unknown');expect(db.serialize()).toEqual(before);
  const original=db.prepare('SELECT * FROM memory_command_schema').all();prepareSemanticMemory(db);expect(semanticCardsReady(db)).toBe(true);expect(db.prepare('SELECT * FROM memory_command_schema').all()).toEqual(original);
  db.exec("UPDATE memory_card_schema SET sql='unknown preparation'");const unknown=db.serialize();expect(()=>prepareSemanticMemory(db)).toThrow('Unknown private card preparation');expect(db.serialize()).toEqual(unknown);
 }finally{db.close();}
});
