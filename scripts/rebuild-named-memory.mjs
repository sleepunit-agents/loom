import assert from 'node:assert/strict';

export async function namedMemoryLifecycle({call,post}){
 const title='Fictional seed cabinet',original='The fictional seeds belong in the blue cupboard.',edited='The fictional seeds belong in the green cupboard.';
 const other='Fictional spare cabinet';
 const propose=async(name,content)=>{
  const answer=await call('memory_propose',{category:'reference',title:name,content,ttl:'permanent'});
  const id=/\(([^()]+)\)$/.exec(answer)?.[1];assert.ok(id);return id;
 };
 const draft=await propose(title,original),untouched=await propose(other,'The spare cabinet is empty.');
 const search=()=>call('recall',{query:'seed cabinet',category:'reference',limit:50});
 assert(!(await search()).includes(original));
 await call('memory_ratify',{id:draft});
 const drafts=await call('memory_drafts',{});
 assert(drafts.includes(untouched) && !drafts.includes(draft));
 const recalled=await search();
 const id=recalled.split('---').find(row=>row.includes(title)&&row.includes(original))?.match(/reference · (\S+) · updated/)?.[1];
 assert.ok(id,'Ratified words must appear in recall');
 const read=async()=>(await post('/graphql',{query:'query($id:String!){memoryProjectMemory(id:$id){content} memoryArchive(agent:"fern"){entries{id content note}} memoryHistory(id:$id){id content}}',variables:{id}})).data;
 await call('update',{id,content:edited});
 assert.equal((await read()).memoryProjectMemory.content,edited);
 await call('memory_archive',{id,note:'Testing the archive'});
 const archived=await read();
 assert.equal(archived.memoryProjectMemory,null);
 assert.deepEqual(archived.memoryArchive.entries.find(row=>row.id===id),{id,content:edited,note:'Testing the archive'});
 assert(!(await search()).includes(edited));
 await call('memory_restore',{id});
 const restored=await read();
 assert(!restored.memoryArchive.entries.some(row=>row.id===id));
 assert.equal(restored.memoryProjectMemory.content,edited);
 assert((await search()).includes(edited));
 const earlier=restored.memoryHistory.find(row=>row.content===original);assert.ok(earlier);
 await call('memory_restore',{id,revision:earlier.id});
 const reverted=await read();
 assert.equal(reverted.memoryProjectMemory.content,original);
 assert(reverted.memoryHistory.some(row=>row.content===edited));
 assert((await call('memory_drafts',{})).includes(untouched));
 return {ok:true,reason:'The agent ratified one of two drafts, archived and restored the active memory, then restored its original words. Independent reads checked the archive, the displaced revision and the untouched draft.'};
}
