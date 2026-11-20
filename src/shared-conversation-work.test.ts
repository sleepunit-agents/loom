import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw} from '../test/fixtures/conversation-body.js';
import {changes,projectMembers,tasks} from './core/data/schema.js';
import {sourceQuery,changeQuery,taskQuery} from '../web/src/pieces/comms/work-query.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
it.each(['house/loom#1','https://github.com/house/loom/pull/1'])('reads PRs filed on current visible source tasks, while rejecting hidden conversations, source tasks and changes through the actual UI query (%s)',async citation=>{
 const f=await bodyFixture(clean),at=new Date(f.clock.now()).toISOString(),actor={kind:'agent' as const,id:'art'},service=f.root.services.tasks;
 const source=service.create({title:'Source work',goal:'Work',why:'Needed',owner:actor,project:'pond',source:{kind:'conversation',id:f.thread.conversation}},actor);
 const elsewhere=service.create({title:'Elsewhere',goal:'Work',why:'Needed',owner:actor,project:'pond'},actor);
 const base={repository:'house/loom',body:'',url:'',state:'open' as const,draft:false,authorLogin:'someone',agent:null,branch:'work',headCommit:'a'.repeat(40),baseBranch:'next',checks:'passing' as const,review:'approved' as const,mergeable:'yes' as const,waitingOn:'author' as const,openedAt:at,updatedAt:at};
 f.db.insert(changes).values([{...base,id:'github:house/loom#1',number:1,title:'Made here',project:'pond'},{...base,id:'github:house/loom#2',number:2,title:'Hidden change',project:'other'},{...base,id:'github:house/loom#3',number:3,title:'Not made here',project:'pond'},{...base,id:'github:house/loom#4',number:4,title:'Second source',project:'pond'}]).run();
 service.comment(source.id,'Filed '+citation+' and house/loom#2 and house/loom#4',actor);service.comment(elsewhere.id,'Filed house/loom#3',actor);
 const query=async(conversation=f.thread.conversation,offset=0)=>(await (await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.member},body:JSON.stringify({query:sourceQuery,variables:{conversation,offset}})})).json());
 expect(await query()).toMatchObject({data:{conversationMadeChanges:[{id:'github:house/loom#1'},{id:'github:house/loom#4'}]}});expect((await query()).errors).toBeUndefined();
 expect((await query(f.thread.conversation,2)).data.conversationMadeChanges).toEqual([]);
 const pageQuery='query Pages($cv:String!){first:conversationMadeChanges(conversation:$cv,limit:1,offset:0){id} second:conversationMadeChanges(conversation:$cv,limit:1,offset:1){id} member:conversationMadeChanges(conversation:$cv,change:"github:house/loom#4",limit:1){id}}';
 const pages=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.member},body:JSON.stringify({query:pageQuery,variables:{cv:f.thread.conversation}})});
 expect((await pages.json()).data).toEqual({first:[{id:'github:house/loom#1'}],second:[{id:'github:house/loom#4'}],member:[{id:'github:house/loom#4'}]});
 for(const [query,variables] of [[changeQuery,{id:'github:house/loom#4',conversation:f.thread.conversation}],[taskQuery,{id:source.id}]] as const){
  const answer=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.member},body:JSON.stringify({query,variables})});const body=await answer.json();expect(body.errors).toBeUndefined();
  if(query===changeQuery)expect(body.data.conversationMadeChanges).toEqual([{id:'github:house/loom#4'}]);else expect(body.data.tasks[0]).toMatchObject({sourceKind:'conversation',sourceId:f.thread.conversation});
 }
 const hidden=f.root.services.comms!.threads.open({member:'bob',agent:'mark',title:'Hidden'});
 f.db.update(tasks).set({sourceId:hidden.conversation}).where(eq(tasks.id,source.id)).run();expect((await query(hidden.conversation)).data.conversationMadeChanges).toEqual([]);
 f.db.update(tasks).set({sourceId:f.thread.conversation,project:'other'}).where(eq(tasks.id,source.id)).run();expect((await query()).data.conversationMadeChanges).toEqual([]);
 f.db.update(tasks).set({project:'pond'}).where(eq(tasks.id,source.id)).run();f.db.delete(projectMembers).where(eq(projectMembers.member,'alice')).run();expect((await query()).data.conversationMadeChanges).toEqual([]);
});

it('bounds the actual Comms source read at two and ten cited changes',async()=>{
 const f=await bodyFixture(clean),at=new Date(f.clock.now()).toISOString(),actor={kind:'agent' as const,id:'art'},service=f.root.services.tasks;
 const source=service.create({title:'Source work',goal:'Work',why:'Needed',owner:actor,project:'pond',source:{kind:'conversation',id:f.thread.conversation}},actor);
 const request=()=>f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.member},body:JSON.stringify({query:sourceQuery,variables:{conversation:f.thread.conversation,offset:0}})});
 const prepared=vi.spyOn(f.db.$client,'prepare');let small=0;
 try{
  for(let n=0;n<10;n++){
   const id='github:house/loom#'+(n+1);
   f.db.insert(changes).values({id,repository:'house/loom',number:n+1,title:'Change '+n,body:'',url:'',state:'open',draft:false,authorLogin:'someone',project:'pond',branch:'work',headCommit:'a'.repeat(40),baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'author',openedAt:at,updatedAt:at}).run();
   service.comment(source.id,'Filed '+id,actor);
   if(n===1||n===9){
    // Exclude one-time installed-service catalogue initialization from row growth.
    if(n===1)await (await request()).json();
    prepared.mockClear();const response=await request();const result=await response.json();
    expect(result.errors).toBeUndefined();expect(result.data.conversationMadeChanges).toHaveLength(n+1);
    const count=prepared.mock.calls.filter(([query])=>/^select|^with/i.test(query.trim())).length;
    if(n===1)small=count;else expect(count).toBe(small);
   }
  }
  expect(small).toBe(37);
 }finally{prepared.mockRestore();}
});
