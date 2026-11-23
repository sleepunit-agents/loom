import assert from 'node:assert/strict';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {withFictionalMemoryHome} from './rebuild-memory-home.mjs';

export function sharedHouseholdFiles(){
 return withFictionalMemoryHome(async({issue,command,open,start,post,home})=>{
  const owner=issue({kind:'owner',member:'alex',label:'Fictional household owner'});
  const readers=['fern','moss'].map(agent=>issue({kind:'agent',agent,label:'Fictional reader '+agent}));
  const proposal=await command('household/propose',{change:'settings',input:{defaultAgent:'fern'},why:'Choose the agent for this fictional relationship.'},readers[0]);
  await command('approvals/answer',{id:proposal.id,answer:'allow'},owner);
  const person='Orchard supplier', email='seeds@example.invalid', summary='Met during the fictional harvest';
  const {slug:contact}=await command('mind/personAdd',{name:person,channel:'email',handle:email,summary},owner);
  const body='Use the north-facing storehouse for seeds.';
  const {slug:page}=await command('mind/knowledgeAdd',{title:'Seed storage',domain:'fixture',body,source:''},owner);
  await open(start+1000);
  const query=`query($id:String!,$slug:String!){
   memoryPerson(id:$id){name card{where{key value{text}}}}
   memoryKnowledgePage(slug:$slug){body}
  }`;
  for(const token of [owner,...readers]){
   const result=await post('/graphql',{query,variables:{id:'commons:'+contact,slug:page}},200,token);
   assert.deepEqual(result.data.memoryKnowledgePage,{body});
   const ownerCard={name:person,card:{where:[{key:'email',value:{text:email}}]}};
   assert.deepEqual(result.data.memoryPerson,token===owner?ownerCard:null);
  }
  function stored(file,sql,slug){
   const db=new Database(join(home,...file),{readonly:true,fileMustExist:true});
   try{return db.prepare(sql).pluck().get(slug);}finally{db.close();}
  }
  assert.equal(stored(['commons','knowledge.db'],'SELECT body FROM pages WHERE slug=?',page),body);
  const personSql='SELECT card_json FROM people WHERE slug=?';
  const directory=JSON.parse(stored(['commons','people.db'],personSql,contact));
  assert.equal(directory.where.email.value,email);
  assert.ok(!JSON.stringify(directory).includes(summary));
  const relationship=JSON.parse(stored(['agents','fern','memories.db'],personSql,contact));
  assert.equal(relationship.summary,summary);
  assert.equal(stored(['agents','moss','memories.db'],personSql,contact),undefined);
  return {ok:true,reason:'After restart the owner read the directory contact, and the owner and two agents read the same Knowledge page. Both records were present in the shared household files. The relationship summary lived in the default agent’s file.'};
 });
}
