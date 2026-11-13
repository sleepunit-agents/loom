import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mindTouchSources, mindTouchResolver } from './binding.js';
it('admits only existing sources, bound viewers and canonical agent/commons namespaces',()=>{
  const h=mkdtempSync(join(tmpdir(),'mind-bind-'));
  try{
    const commons={directory:join(h,'commons'),knowledge:join(h,'commons/knowledge.db'),people:join(h,'commons/people.db')};
    const art={agent:'art',directory:join(h,'art'),memories:join(h,'art/memories.db')};
    const mark={agent:'mark',directory:join(h,'mark'),memories:join(h,'mark/memories.db')};
    mkdirSync(commons.directory);mkdirSync(art.directory);writeFileSync(commons.people,'');writeFileSync(art.memories,'');
    const sources=mindTouchSources({commons,agents:[art,mark]});const resolve=mindTouchResolver(sources);
    expect(sources.map(s=>s.directory)).toEqual([commons.directory,art.directory]);
    const owner={kind:'service' as const,id:'mind:commons'},agent={kind:'agent' as const,id:'art'};
    expect(sources[0].resolve({type:'person',id:'jonathan'})).toEqual({type:'person',id:'commons:jonathan'});
    expect(resolve(owner,{type:'person',id:'commons:jonathan'})).toEqual({type:'person',id:'commons:jonathan'});
    expect(resolve(owner,{type:'knowledge',id:'fact'})).toBeUndefined();
    expect(resolve(owner,{type:'person',id:'art:jonathan'})).toBeUndefined();
    for(const type of ['memory','person','project']){
      expect(sources[1].resolve({type,id:'item'})).toEqual({type,id:'art:item'});
      expect(resolve(agent,{type,id:'art:item'})).toEqual({type,id:'art:item'});
      expect(resolve(agent,{type,id:'mark:item'})).toBeUndefined();
      expect(resolve(agent,{type,id:'art:'})).toBeUndefined();
      expect(resolve({kind:'agent',id:'mark'},{type,id:'art:item'})).toBeUndefined();
    }
    expect(resolve({kind:'member',id:'art'},{type:'memory',id:'art:item'})).toBeUndefined();
    expect(resolve(agent,{type:'knowledge',id:'art:fact'})).toBeUndefined();
  }finally{rmSync(h,{recursive:true,force:true});}
});
