import { expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fault=vi.hoisted(()=>({path:''}));
vi.mock('node:fs',async importOriginal=>{
  const original=await importOriginal<typeof import('node:fs')>();
  return {...original,chmodSync:(path:import('node:fs').PathLike,mode:import('node:fs').Mode)=>{
    if(path===fault.path)throw new Error('injected endpoint chmod failure');
    return original.chmodSync(path,mode);
  }};
});
import { createFoundation } from '../app.js';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../clock.js';
import { migrateHouseholdTables } from '../household/schema.js';
import { HouseholdDatabase } from '../household/document.js';
import { SqliteKnowledgeBackend } from '../../backends/sqlite-knowledge.js';
import { touchSocketPath } from './index.js';
it('closes the newly bound socket and earlier listeners if post-bind chmod fails',async()=>{
  const home=mkdtempSync(join(tmpdir(),'touch-chmod-'));
  // Seed metadata/content offline; every listener starts through startLoom.
  const metadata=createFoundation({home});migrateHouseholdTables(metadata.db);
  metadata.db.transaction(()=>new HouseholdDatabase(metadata.db).replace(home,{v:1,agents:['art'],default:'art',owner:'owner'}))();metadata.close();
  const source=new SqliteKnowledgeBackend({dbPath:join(home,'commons/knowledge.db')});
  await source.writePage({slug:'fact',title:'Fact',domain:'systems',body:'Body'});
  const agent=join(home,'agents/art');mkdirSync(agent,{recursive:true});writeFileSync(join(agent,'memories.db'),'');
  const sources=[join(home,'commons'),agent];fault.path=touchSocketPath(agent);
  try{
    await expect(startLoom({home,next:true,clock:new FakeClock()})).rejects.toThrow('injected endpoint chmod failure');
    for(const directory of sources)expect(existsSync(touchSocketPath(directory))).toBe(false);
    fault.path='';const app=await startLoom({home,next:true,clock:new FakeClock()});await app.close();
  }finally{fault.path='';source.close();rmSync(home,{recursive:true,force:true});}
});
