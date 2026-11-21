import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {withFictionalMemoryHome} from './rebuild-memory-home.mjs';

const samples=[
 ['Orchid','A bicycle mechanic patches punctured inner tubes.','repairing flat tires'],
 ['Beryl','The baker kneads sourdough before baking loaves.','bread preparation'],
 ['Cobalt','Our observatory tracks distant galaxies with telescopes.','astronomy instruments'],
];

const result=await withFictionalMemoryHome(async({start,open,command,post})=>{
 const ids=[];
 const words=text=>text.toLowerCase().match(/[a-z]+/g);
 const digest=async()=>(await post('/graphql',{query:'{memoryIdentity(agent:"fern"){topOfMind}}'})).data.memoryIdentity.topOfMind;
 const recall=async i=>assert.deepEqual((await command('memory/recall',{query:samples[i][2],limit:1})).ids,[ids[i]]);
 // The store timestamps writes and recall heat from Date. The coordinator has its own clock.
 mock.timers.enable({apis:['Date'],now:start});
 try{
  for(const [title,content,query] of samples){
   assert.ok(words(query).every(word=>!words(title+' '+content).includes(word)));
   const row=await command('memory/remember',{title,content,category:'reference',ttl:'permanent'});
   assert.equal(row.ids.length,1);
   ids.push(row.ids[0]);
  }
  assert.deepEqual((await command('memory/bands',{})).bands,{Hot:3,Warm:0,Cool:0});
  const later=start+90*86_400_000;
  mock.timers.setTime(later);
  await open(later);
  assert.deepEqual((await command('memory/bands',{})).bands,{Hot:0,Warm:3,Cool:0});
  assert.ok(!(await digest())?.includes('## Top of mind'));
  for(const i of [1,2,0])await recall(i);
  for(let repeat=0;repeat<3;repeat++)await recall(0);
  assert.deepEqual((await command('memory/bands',{})).bands,{Hot:1,Warm:2,Cool:0});
  const hot=await digest(),[top,recent]=hot.split('## Recent');
  assert.ok(top.includes('## Top of mind')&&top.includes('**Orchid**')&&!top.includes('Beryl')&&!top.includes('Cobalt'));
  assert.ok(recent.includes('**Beryl**')&&recent.includes('**Cobalt**'));
  mock.timers.setTime(later+1000);
  await open(later+1000);
  assert.equal(await digest(),hot);
  return {ok:true,paraphrases:samples.length,reason:'Three paraphrases with no shared words each recalled the matching fact first. After 90 days of cooling, recalling one fact repeatedly put only that fact at the top of mind. The ordering survived restart.'};
 }finally{mock.timers.reset();}
},{realEmbedding:true});
console.log(JSON.stringify(result));
