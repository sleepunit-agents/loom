import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { migrateAttention } from './migrate-attention.js';
it.each([false,true])('refuses source=destination before writable open, hardlink=%s',async alias=>{
  const home=mkdtempSync(join(tmpdir(),'attention-self-cli-')),destination=join(home,'loom.db'),map=join(home,'scopes.json');
  try {
    const old=new Database(destination); old.exec('CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES (\'old copy\')'); old.close();
    const from=alias?join(home,'alias.db'):destination;if(alias)linkSync(destination,from);writeFileSync(map,'{}');
    const before=readFileSync(destination);let stderr='';
    const result=await migrateAttention(['--home',home,'--from',from,'--scopes',map],{stdout:()=>{},stderr:s=>{stderr+=s;},stdin:Readable.from([]),stdinIsTTY:false,env:{}});
    expect(result).toBe(1);expect(stderr).toMatch(/source and destination must differ/);expect(readFileSync(destination)).toEqual(before);
    const read=new Database(destination,{readonly:true});try{expect(read.pragma('journal_mode',{simple:true})).toBe('delete');expect(read.prepare("SELECT name FROM sqlite_master WHERE name='core_migrations'").get()).toBeUndefined();}finally{read.close();}
  }finally{rmSync(home,{recursive:true,force:true});}
});
