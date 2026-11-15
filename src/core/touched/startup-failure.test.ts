import { expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
import Database from 'better-sqlite3';
import {createDataSchema} from '../data/database.js';
import {agents,household} from '../data/schema.js';
import {serveShared} from '../../shared-serve.js';
import {FakeClock} from '../clock.js';
import {touchSocketPath} from './index.js';
it('closes the newly bound socket and earlier listeners if post-bind chmod fails',async()=>{
  const home=mkdtempSync(join(tmpdir(),'touch-chmod-'));
  const client=new Database(':memory:'),db=createDataSchema(client),clock=new FakeClock();
  db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(household).values({defaultAgent:'art'}).run();
  const common=join(home,'commons'),agent=join(home,'agents/art'),memory={checkingAgent:'art',sources:{commons:{directory:common,knowledge:join(common,'knowledge.db'),people:join(common,'people.db')},agents:[{agent:'art',directory:agent,memories:join(agent,'memories.db')}]}};
  const start=()=>serveShared({db,clock,memory,originAllowed:()=>true,reportError:()=>{}});
  const sources=[join(home,'commons'),agent];fault.path=touchSocketPath(agent);
  try{
    await expect(start()).rejects.toThrow('injected endpoint chmod failure');
    for(const directory of sources)expect(existsSync(touchSocketPath(directory))).toBe(false);
    fault.path='';const app=await start();await app.close();
  }finally{fault.path='';client.close();rmSync(home,{recursive:true,force:true});}
});
