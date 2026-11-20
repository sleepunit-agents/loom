import assert from 'node:assert/strict';
import {withFictionalMemoryHome} from './rebuild-memory-home.mjs';

export function memoryRevisionEvidence() {
 return withFictionalMemoryHome(async ({command,post,open,start})=>{
  const word=(kind,version)=>'Fictional orchard '+kind+' revision '+version;
  async function seed(tag) {
   const memory=(await command('memory/remember',{title:'Fictional memory '+tag,category:'reference',content:word('memory '+tag,0),ttl:'permanent'})).ids[0];
   const slug='orchard-friend-'+tag;
   const person=(await command('memory/personWrite',{slug,name:'Orchard Friend '+tag,summary:word('person '+tag,0)})).ids[0];
   const page=(await command('mind/knowledgeAdd',{title:'Orchard revisions '+tag,domain:'fictional',body:word('knowledge '+tag,0)})).slug;
   return {memory,slug,person,page,tag};
  }
  async function edit({memory,slug,page,tag},version){
   await command('memory/update',{id:memory,content:word('memory '+tag,version)});
   await command('memory/personWrite',{slug,summary:word('person '+tag,version)});
   await command('mind/knowledgeEdit',{slug:page,body:word('knowledge '+tag,version)});
  }
  const query='query($memory:String!,$person:String!,$page:String!){memoryHistory(id:$memory){id content} memoryProjectMemory(id:$memory){content} memoryPerson(id:$person){card{summary} history{id card{summary}}} memoryKnowledgePage(slug:$page){body history{id body}}}';
  async function read({memory,person,page,tag}){
   const {data}=await post('/graphql',{query,variables:{memory,person,page}});
   return [
    {kind:'memory '+tag,current:data.memoryProjectMemory.content,history:data.memoryHistory.map(r=>({id:r.id,words:r.content}))},
    {kind:'person '+tag,current:data.memoryPerson.card.summary,history:data.memoryPerson.history.map(r=>({id:r.id,words:r.card.summary}))},
    {kind:'knowledge '+tag,current:data.memoryKnowledgePage.body,history:data.memoryKnowledgePage.history.map(r=>({id:r.id,words:r.body}))},
   ];
  }
  const control=await seed('control');
  await edit(control,1);
  const controlRows=await read(control);
  for(const row of controlRows){
   assert.equal(row.current,word(row.kind,1));
   assert.deepEqual(row.history.map(r=>r.words),[word(row.kind,0)]);
  }
  const target=await seed('target');
  function restoreRequests(ids) {
   return [
    ['memory/restoreRevision',{id:target.memory,revision_id:ids[0]}],
    ['memory/personRestoreRevision',{slug:target.slug,revision_id:ids[1]}],
    ['mind/knowledgeRestore',{slug:target.page,revision:ids[2]}],
   ];
  }
  async function expectVersions(current,prior){
   const rows=await read(target);
   for(const row of rows){
    assert.equal(row.current,word(row.kind,current));
    assert.deepEqual(row.history.map(r=>r.words),prior.map(version=>word(row.kind,version)));
   }
   return rows;
  }
  const prior=[];
  const evicted=[];
  for(let version=1;version<=12;version++){
   await edit(target,version);
   prior.unshift(version-1);
   prior.splice(10);
   const rows=await expectVersions(version,prior);
   if(version<=2) evicted.push(rows.map(row=>row.history[0].id));
  }
  const saved=await read(target);
  await open(start+1000);
  assert.deepEqual(await read(target),saved);
  for(const [version,ids] of evicted.entries()){
   for(const [name,input] of restoreRequests(ids)){
    // The card API classifies an absent revision as an invalid card request.
    const card=name==='memory/personRestoreRevision';
    const result=await post('/api/'+name,{id:'expired-'+version+'-'+name.replace('/','-'),input},card?400:404);
    assert.equal(result.ok,false);
    assert.equal(result.code,card?'invalid':'not-found');
   }
   assert.deepEqual(await read(target),saved);
  }
  let current=12;
  async function restore(rows,index,version){
   for(const [name,input] of restoreRequests(rows.map(row=>row.history[index].id)))await command(name,input);
   prior.unshift(current);
   prior.splice(10);
   current=version;
   await expectVersions(current,prior);
  }
  // Oldest first preserves each original ID until exercised.
  for(let index=9;index>=0;index--)await restore(saved,index,11-index);
  // Restoring a middle revision must still evict the oldest.
  await restore(await read(target),4,prior[4]);
  assert.deepEqual(await read(control),controlRows);
  return {ok:true,types:['memory','person','knowledge'],editsPerType:12,originalVersionsRestoredPerType:10,restoreCallsPerType:11,
   reason:'After each of 12 edits per record, the current words and ordered prior versions matched. After restart, every one of the ten retained versions restored the expected words and saved the displaced version.'};
 });
}
