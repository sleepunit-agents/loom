import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {withNamedTools} from './rebuild-named-tool-client.mjs';
import {withFictionalMemoryHome} from './rebuild-memory-home.mjs';

const samples=[
 ['Orchid','A bicycle mechanic patches punctured inner tubes.','repairing flat tires'],
 ['Beryl','The baker kneads sourdough before baking loaves.','bread preparation'],
 ['Cobalt','Our observatory tracks distant galaxies with telescopes.','astronomy instruments'],
];

const result=await withFictionalMemoryHome(async({start,open,command,post,connectAgent})=>{
 const ids=[];
 const words=text=>text.toLowerCase().match(/[a-z]+/g);
 const digest=async()=>(await post('/graphql',{query:'{memoryIdentity(agent:"fern"){topOfMind}}'})).data.memoryIdentity.topOfMind;
 const recall=async(call,i)=>{
  const result=await call('recall',{query:samples[i][2],limit:1});
  assert(result.includes(ids[i]) && result.includes(samples[i][1]));
  assert(ids.every((id,index)=>index===i||!result.includes(id)));
 };
 // The store timestamps writes and recall heat from Date. The coordinator has its own clock.
 mock.timers.enable({apis:['Date'],now:start});
 try{
  await withNamedTools(connectAgent(),async call=>{
   for(const [title,content,query] of samples){
    assert.ok(words(query).every(word=>!words(title+' '+content).includes(word)));
    const answer=await call('remember',{title,content,category:'reference',ttl:'permanent'});
    const id=/\(([^()]+)\)$/.exec(answer)?.[1];assert.ok(id);ids.push(id);
   }
  });
  assert.deepEqual((await command('memory/bands',{})).bands,{Hot:3,Warm:0,Cool:0});
  const later=start+90*86_400_000;
  mock.timers.setTime(later);
  await open(later);
  assert.deepEqual((await command('memory/bands',{})).bands,{Hot:0,Warm:3,Cool:0});
  assert.ok(!(await digest())?.includes('## Top of mind'));
  await withNamedTools(connectAgent(),async call=>{
   for(const i of [1,2,0])await recall(call,i);
   for(let repeat=0;repeat<3;repeat++)await recall(call,0);
  });
  assert.deepEqual((await command('memory/bands',{})).bands,{Hot:1,Warm:2,Cool:0});
  const hot=await digest(),[top,recent]=hot.split('## Recent');
  assert.ok(top.includes('## Top of mind')&&top.includes('**Orchid**')&&!top.includes('Beryl')&&!top.includes('Cobalt'));
  assert.ok(recent.includes('**Beryl**')&&recent.includes('**Cobalt**'));
  mock.timers.setTime(later+1000);
  await open(later+1000);
  assert.equal(await digest(),hot);
  let namedMemoryChanges;
  try{
   await withNamedTools(connectAgent(),async call=>{
    const content=async id=>(await post('/graphql',{query:'query($id:String!){memoryProjectMemory(id:$id){content}}',variables:{id}})).data.memoryProjectMemory;
    const edited='The mechanic replaced the damaged bicycle wheel.';
    await call('update',{id:ids[0],content:edited});
    assert.deepEqual(await content(ids[0]),{content:edited});
    const changed=await call('recall',{query:'cycle repair',limit:1});
    assert(changed.includes(ids[0]) && changed.includes(edited) && !changed.includes(samples[0][1]));
    await call('forget',{id:ids[0]});
    assert.equal(await content(ids[0]),null);
    assert(!(await call('recall',{query:'cycle repair',limit:50})).includes(ids[0]));
    for(const i of [1,2])await recall(call,i);
   });
   namedMemoryChanges={ok:true,reason:'An agent used remember and recall with the real embedding model. Each of three paraphrases returned the matching fact. The agent edited and deleted one fact, and independent reads and recall showed both changes while the other two facts stayed available.'};
  }catch(error){namedMemoryChanges={ok:false,error:String(error)};}
  return {ok:true,namedMemoryChanges,paraphrases:samples.length,reason:'Three paraphrases with no shared words each recalled the matching fact first. After 90 days of cooling, recalling one fact repeatedly put only that fact at the top of mind. The ordering survived restart.'};
 }finally{mock.timers.reset();}
},{realEmbedding:true});
console.log(JSON.stringify(result));
