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
import { createFoundation } from '../app.js';
import { installTouched, touchSocketPath } from './index.js';
import { listenForTouchSources } from './group.js';
it('closes the newly bound socket and earlier listeners if post-bind chmod fails',async()=>{
  const h=mkdtempSync(join(tmpdir(),'touch-chmod-'));const app=createFoundation({home:join(h,'daemon')});
  const sources=['one','two'].map(id=>({directory:join(h,id),viewer:{kind:'agent' as const,id},resolve:(c:{type:string;id:string})=>c}));
  installTouched(app.operations,(_v,c)=>c);fault.path=touchSocketPath(sources[1].directory);
  try{
    await expect(listenForTouchSources(app.operations,sources)).rejects.toThrow('injected endpoint chmod failure');
    for(const source of sources)expect(existsSync(touchSocketPath(source.directory))).toBe(false);
    fault.path='';const stop=await listenForTouchSources(app.operations,sources);await stop();
  }finally{fault.path='';app.close();rmSync(h,{recursive:true,force:true});}
});
