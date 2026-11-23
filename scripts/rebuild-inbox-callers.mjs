import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** The last observation in the disposable home. External callers go through its HTTP door. */
export async function inboxCallers({app,example}){
 const s=app.services,issued=[];
 const write=fn=>app.writes.run(fn).value;
 const label='Walkthrough mailbox audience';
 const query=async(token,document)=>{
  const response=await fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query:document})});
  return {status:response.status,body:await response.json()};
 };
 const keep=credential=>{issued.push(credential.fingerprint);return credential.token;};
 try{
  const rows=write(()=>[['person','alex'],['person','robin'],['agent','fern']].map(([toKind,to])=>s.conversations.send({
   toKind,to,source:'notice',fromKind:'schedule',words:label+' '+to,...(toKind==='person'?{member:to}:{agent:to}),
  })));
  for(const row of rows)assert.equal(s.conversations.item(row.id).words,label+' '+row.to);
  const mailbox='{inboxItems(folder:"all",search:"Walkthrough mailbox audience"){id toKind to}}';
  for(const row of rows){
   const identity=row.toKind==='person'?{kind:'owner',member:row.to}:{kind:'agent',agent:row.to};
   const token=keep(write(()=>s.signin.issue({...identity,label:label+' '+row.to})));
   assert.deepEqual(await query(token,mailbox),{status:200,body:{data:{inboxItems:[{id:row.id,toKind:row.toKind,to:row.to}]}}});
  }
  const worker=keep(write(()=>s.signin.issue({kind:'runner',box:example.runtime.box,label:label+' worker'})));
  const poll=await fetch(app.url+'/api/runtime/machineReadNext',{method:'POST',headers:{authorization:'Bearer '+worker,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{reads:[]}})});
  assert.equal(poll.status,200);assert.equal((await poll.json()).ok,true);
  const workerMail=await query(worker,mailbox);
  assert.equal(workerMail.status,403);assert.equal(workerMail.body.data,undefined);
  const program=keep(write(()=>s.programSetup.issue({member:'robin',label:label+' program',records:['projects'],operations:[]})));
  const projects=await query(program,'{projects{id}}');
  assert.equal(projects.status,200);assert.equal(projects.body.errors,undefined);assert.ok(projects.body.data.projects.some(p=>p.id==='garden'));
  const programMail=await query(program,mailbox);
  assert.equal(programMail.status,200);assert.equal(programMail.body.data,undefined);
  assert.ok(programMail.body.errors.some(error=>error.message.includes('Cannot query field "inboxItems"')));
  return {ok:true,reason:'The internal mailbox service read all three fixture items directly. Over HTTP, the owner, member and agent each listed only their own item. A working machine credential could poll its worker route and had no data projection. A project-only program read the garden project and its schema omitted Inbox.'};
 }catch(error){return {ok:false,error:String(error)};}
 finally{for(const key of issued)write(()=>s.signin.revoke(key));}
}
