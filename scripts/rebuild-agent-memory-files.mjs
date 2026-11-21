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
   const path='isolation/sample';
   await command('memory/noteWrite',{path,body:fact.content,lifespan:'keep'},fact.token);
   fact.person=(await command('memory/personWrite',{slug:'file-sample',name:'Sample friend',summary:fact.content},fact.token)).ids[0];
   fact.project=(await command('memory/projectWrite',{slug:'file-sample',name:'Sample project',summary:fact.content},fact.token)).ids[0];
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
  const query=`query($agent:String!,$memory:String!,$person:String!,$project:String!){
   memoryProjectMemory(id:$memory){content}
   memoryNote(agent:$agent,path:"isolation/sample"){body}
   memoryPerson(id:$person){card{summary}}
   memoryProject(id:$project){card{summary}}
  }`;
  const memberToken=member=>issue({kind:'owner',member,label:'File walkthrough '+member});
  const viewers=[
   {token:facts[0].token,agents:['fern']},{token:facts[1].token,agents:['moss']},
   {token:memberToken('alex'),agents:['fern','moss']},{token:memberToken('robin'),agents:['moss']}
  ];
  for(const {token,agents:visible} of viewers){
   for(const {agent,id:memory,person,project,content} of facts){
    const {data}=await post('/graphql',{query,variables:{agent,memory,person,project}},200,token);
    const expected=visible.includes(agent);
    assert.deepEqual(data,{
     memoryProjectMemory:expected?{content}:null,memoryNote:expected?{body:content}:null,
     memoryPerson:expected?{card:{summary:content}}:null,memoryProject:expected?{card:{summary:content}}:null,
    },'Unexpected private data visibility for '+agent+' with access to '+visible.join(', '));
   }
  }
  return {ok:true,reason:'After restart both facts lived in separate agent files. Each agent read its own fact, note, person card and project card. The household owner read both sets. A member sharing a project with both agents read only the set from the agent they own.'};
 });
}
