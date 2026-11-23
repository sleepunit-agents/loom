import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Read the same three conversations through the installed service and the outside HTTP doors. */
export async function conversationCallers({app,example}) {
 const {conversations,signin,programSetup}=app.services;
 const write=fn=>app.writes.run(fn).value;
 const credentials=[];
 function issue(create) {
  const credential=write(create);
  credentials.push(credential.fingerprint);
  return credential.token;
 }
 const label='Walkthrough conversation readers';
 const rooms=write(()=>[
  conversations.open({agent:'fern',member:'alex',venue:'loom',place:randomUUID(),label}),
  conversations.open({agent:'moss',member:'robin',venue:'loom',place:randomUUID(),label}),
  conversations.open({agent:'fern',project:'garden',venue:'wake',place:randomUUID(),label}),
 ]);
 const [alex,robin,garden]=rooms.map(room=>room.id);
 const read=async token=>{
  const response=await fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
   body:JSON.stringify({query:'query($label:String!){conversations(where:{label:{eq:$label}}){id}}',variables:{label}})});
  return {status:response.status,body:await response.json()};
 };
 async function expectRooms(token,ids) {
  const {status,body}=await read(token);
  assert.equal(status,200);
  assert.equal(body.errors,undefined);
  assert.deepEqual(body.data.conversations.map(row=>row.id).sort(),[...ids].sort());
 }
 try {
  for(const room of rooms)assert.deepEqual(conversations.conversation(room.id),room);
  for(const [member,visible] of [['alex',[alex,garden]],['robin',[robin,garden]]]){
   await expectRooms(issue(()=>signin.issue({kind:'owner',member,label:label+' '+member})),visible);
  }
  await expectRooms(issue(()=>signin.issue({kind:'agent',agent:'fern',label:label+' Fern'})),[garden]);
  await expectRooms(issue(()=>programSetup.issue({member:'robin',label:label+' program',records:['conversations'],operations:[]})),[robin,garden]);
  const worker=issue(()=>signin.issue({kind:'runner',box:example.runtime.box,label:label+' worker'}));
  const poll=await fetch(app.url+'/api/runtime/machineReadNext',{method:'POST',headers:{authorization:'Bearer '+worker,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{reads:[]}})});
  assert.equal(poll.status,200);assert.equal((await poll.json()).ok,true);
  const result=await read(worker);assert.equal(result.status,403);assert.equal(result.body.data,undefined);
  return {ok:true,reason:'The internal conversation service read all three rooms. The owner and member each saw their own private room and the project room. The agent saw its project room. A program granted conversation reads saw its member’s two rooms. The worker polled its machine route and had no conversation listing.'};
 } finally {
  for(const fingerprint of credentials)write(()=>signin.revoke(fingerprint));
 }
}
