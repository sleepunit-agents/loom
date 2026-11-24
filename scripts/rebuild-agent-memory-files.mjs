import assert from 'node:assert/strict';
import {statSync,writeFileSync} from 'node:fs';
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
   const result=await command('memory/remember',{category:'reference',title:'Isolation sample',content:fact.content+' earlier'},fact.token);
   assert.equal(result.ids.length,1);
   fact.id=result.ids[0];
   await command('memory/update',{id:fact.id,content:fact.content},fact.token);
   await command('memory/propose',{category:'reference',title:'Folder draft',content:fact.content+' draft'},fact.token);
   writeFileSync(join(home,'agents',fact.agent,'IDENTITY.md'),fact.content+' identity');
   const path='isolation/sample';
   await command('memory/noteWrite',{path,body:fact.content+' earlier note',lifespan:'keep'},fact.token);
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
    assert.deepEqual(db.prepare('SELECT content FROM memory_revisions WHERE content IN (?,?)').pluck().all(...facts.map(row=>row.content+' earlier')),[fact.content+' earlier']);
    assert.deepEqual(db.prepare("SELECT content FROM proposals WHERE status='pending' AND title='Folder draft'").pluck().all(),[fact.content+' draft']);
    for(const table of ['people','projects']){
     const card=db.prepare("SELECT card_json FROM "+table+" WHERE slug='file-sample'").pluck().get();
     assert.equal(JSON.parse(card).summary,fact.content);
    }
   }finally{db.close();}
   const notes=new Database(join(home,'agents',fact.agent,'notes.db'),{readonly:true,fileMustExist:true});
   try{
    assert.equal(notes.prepare("SELECT body FROM notes WHERE path='isolation/sample'").pluck().get(),fact.content);
    assert.deepEqual(notes.prepare("SELECT body FROM note_revisions WHERE path='isolation/sample'").pluck().all(),[fact.content+' earlier note']);
   }finally{notes.close();}
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
   memoryIdentity(agent:$agent){creed}
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
     memoryIdentity:expected?{creed:content+' identity'}:null,
     memoryProjectMemory:expected?{content}:null,memoryNote:expected?{body:content}:null,
     memoryPerson:expected?{card:{summary:content}}:null,memoryProject:expected?{card:{summary:content}}:null,
    },'Unexpected private data visibility for '+agent+' with access to '+visible.join(', '));
   }
  }
  return {ok:true,reason:'After restart each agent folder held the current memory and its revision, a pending draft, both cards, the note and its prior version. Each identity query returned the creed from the corresponding folder. Each agent read its own fact, note, person card and project card. The household owner read both sets. A member sharing a project with both agents read only the set from the agent they own.'};
 });
}
