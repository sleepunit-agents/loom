import assert from 'node:assert/strict';
import {statSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {withFictionalMemoryHome} from './rebuild-memory-home.mjs';

export function agentMemoryFiles(){
 return withFictionalMemoryHome(async({home,open,start,command,post,issue})=>{
  const agents=['fern','moss'];
  const facts=agents.map(agent=>({
   agent,content:'Fictional file isolation marker for '+agent,
   token:issue({kind:'agent',agent,label:'File walkthrough '+agent}),
  }));
  for(const fact of facts){
   const result=await command('memory/remember',{category:'reference',title:'Isolation sample',content:fact.content},fact.token);
   assert.equal(result.ids.length,1);
   fact.id=result.ids[0];
  }
  await open(start+1000);
  const files=new Set();
  for(const fact of facts){
   const path=join(home,'agents',fact.agent,'memories.db');
   const {dev,ino}=statSync(path);
   files.add(dev+':'+ino);
   const db=new Database(path,{readonly:true,fileMustExist:true});
   try{
    const rows=db.prepare('select content from memories where content in (?,?)').all(...facts.map(row=>row.content));
    assert.deepEqual(rows,[{content:fact.content}]);
   }finally{db.close();}
  }
  assert.equal(files.size,facts.length);
  for(const path of [join(home,'app.db'),join(home,'commons','knowledge.db'),join(home,'commons','people.db')]){
   const db=new Database(path,{readonly:true,fileMustExist:true});
   try{
    const bytes=db.serialize();
    for(const fact of facts)assert.equal(bytes.includes(Buffer.from(fact.content)),false);
   }finally{db.close();}
  }
  const query='query($fern:String!,$moss:String!){fern:memoryProjectMemory(id:$fern){content} moss:memoryProjectMemory(id:$moss){content}}';
  const variables=Object.fromEntries(facts.map(fact=>[fact.agent,fact.id]));
  const read=async token=>(await post('/graphql',{query,variables},200,token)).data;
  const [fern,moss]=facts.map(fact=>({content:fact.content}));
  assert.deepEqual(await read(facts[0].token),{fern,moss:null});
  assert.deepEqual(await read(facts[1].token),{fern:null,moss});
  const memberToken=member=>issue({kind:'owner',member,label:'File walkthrough '+member});
  assert.deepEqual(await read(memberToken('alex')),{fern,moss});
  assert.deepEqual(await read(memberToken('robin')),{fern:null,moss});
  return {ok:true,reason:'Two agents wrote distinct facts into separate private files. After restart each read only its own fact. The owner read both, and the project colleague assigned to just one agent read only that agent’s fact.'};
 });
}
