import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {withFictionalMemoryHome} from './rebuild-memory-home.mjs';

// Receive the committed reply on the proxy, then close the client socket before acknowledging it.
async function loseReply(url, token, command) {
 let committed, failure;
 const proxy=createServer(async (request,response)=>{
  try {
   const chunks=[];
   for await(const chunk of request)chunks.push(chunk);
   const result=await fetch(url+'/api/tasks/command',{method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:Buffer.concat(chunks)});
   assert.equal(result.status,200);
   committed=await result.json();
  } catch(error){failure=error;}
  finally {response.destroy();}
 });
 try {
  await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
  await assert.rejects(fetch('http://127.0.0.1:'+proxy.address().port,{method:'POST',body:JSON.stringify(command)}));
  if(failure)throw failure;
  assert.equal(committed?.ok,true);
  return committed;
 } finally {await new Promise(resolve=>proxy.close(resolve));}
}

export async function writeReceiptEvidence(){
 return withFictionalMemoryHome(async ({connectAgent,open,post,home,start})=>{
  const {url,token}=connectAgent();
  const title='Retry the fictional seed delivery';
  const input={action:'create',input:{title,goal:'Recover the task ID',why:'The connection dropped',owner:{kind:'agent',id:'fern'}}};
  const command={id:'fixture-lost-task-reply',input};
  const committed=await loseReply(url,token,command);
  assert.ok(committed.value.id);
  const deadline=start+30*86400_000;
  const db=new Database(join(home,'app.db'),{readonly:true,fileMustExist:true});
  try {
   const copies=()=>db.prepare('SELECT id FROM tasks WHERE title=?').all(title);
   const receipt=()=>db.prepare('SELECT expires_at FROM operation_results WHERE operation=? AND id=?').all('tasks.command',command.id);
   assert.deepEqual(copies(),[{id:committed.value.id}]);
   assert.deepEqual(receipt(),[{expires_at:new Date(deadline).toISOString()}]);
   await open(deadline-1);
   const recovered=await post('/api/tasks/command',command);
   assert.deepEqual(recovered.value,committed.value);
   const changed={...input,input:{...input.input,title:'Different fictional delivery'}};
   const conflict=await post('/api/tasks/command',{...command,input:changed},409);
   assert.equal(conflict.ok,false);
   assert.equal(db.prepare('SELECT count(*) AS n FROM tasks WHERE title=?').get(changed.input.title).n,0);
   assert.deepEqual(copies(),[{id:committed.value.id}]);
   assert.deepEqual(receipt(),[{expires_at:new Date(deadline).toISOString()}]);
   await open(deadline);
   const next=await post('/api/tasks/command',command);
   assert.ok(next.value.id);
   assert.notEqual(next.value.id,committed.value.id);
   assert.deepEqual(copies().map(row=>row.id).sort(),[committed.value.id,next.value.id].sort());
   return {ok:true,reason:'The task write committed before the client socket closed. After restart a retry one millisecond before day 30 returned the original task ID with one task stored. At the deadline the same request created a new task.'};
  } finally {db.close();}
 });
}
