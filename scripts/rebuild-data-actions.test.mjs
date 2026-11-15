import {readFileSync} from 'node:fs';
import {evaluate} from './rebuild-report.mjs';
import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {connectionEvidence,changedFields,sqlRead,installDataProbe,auditDataDoor} from './rebuild-data-actions.mjs';
it('requires an active selection with successful data, not just a sent request',()=>{
 const oldSocket=globalThis.WebSocket,oldState=globalThis.__loomDataProbe;
 try{
  globalThis.WebSocket={OPEN:1};const socket={readyState:1,url:'ws://127.0.0.1/graphql'},entry={active:new Map(),frames:[],requests:[{id:'old',query:'query Tasks { tasks { id } }'}]};
  globalThis.__loomDataProbe={sockets:[socket],entries:new Map([[socket,entry]])};
  const proof=()=>connectionEvidence({title:'Tasks',pattern:'query Tasks'}).selectionSeen;
  expect(proof()).toBe(false);entry.active.set('new',{id:'new',query:'query Tasks { tasks { id } }'});expect(proof()).toBe(false);
  entry.frames.push({id:'old'});expect(proof()).toBe(false);entry.frames.push({id:'new'});expect(proof()).toBe(true);
  entry.active.delete('new');expect(proof()).toBe(false);socket.readyState=3;expect(proof()).toBe(false);
 }finally{globalThis.WebSocket=oldSocket;globalThis.__loomDataProbe=oldState;}
});
it('rejects repeated root, collection, row and unchanged-field snapshots',()=>{
 const initial={patches:[{path:[],value:{tasks:[{id:'t',commentCount:1}]}}]};
 const narrow={patches:[{path:['tasks',0,'commentCount'],value:2}]};
 expect(changedFields([initial,narrow],1,'tasks',3)).toBe(true);
 for(const patch of [{path:[],value:{tasks:[]}},{path:['tasks'],value:[{id:'t',commentCount:2}]},{path:['tasks',0],value:{id:'t',commentCount:2}},{path:['tasks',0,'commentCount'],value:1}])expect(changedFields([initial,{patches:[patch]}],1,'tasks',3)).toBe(false);
 expect(changedFields([initial],1,'tasks',3)).toBe(false);
 const inbox={patches:[{path:[],value:{inboxItems:[],inboxFolders:{needs:0}}}]};
 expect(changedFields([inbox,{patches:[{path:['inboxItems',0],value:{id:'new'}},{path:['inboxFolders','needs'],value:1}]}],1,'inboxItems',2)).toBe(true);
 expect(changedFields([inbox,{patches:[{path:['inboxItems'],value:[{id:'new'}]}]}],1,'inboxItems',2)).toBe(false);
});
it('observes tagged SQLite executions, preserves results and restores wrappers on success and failure',async()=>{
 const db=new Database(':memory:');db.exec('create table tasks(id text); insert into tasks values (\'fictitious\')');
 const originalPrepare=db.prepare;let seenRequest,retained,retainedMethod;
 const app={services:{comms:{db:{$client:db}}},http:{fetch:async request=>{seenRequest=request;retained=db.prepare('select id from tasks where id=?');retainedMethod=Object.getPrototypeOf(retained).all;return retained.all('fictitious');}}};
 const originalFetch=app.http.fetch;
 const page={evaluate:async()=>{
  await app.http.fetch(new Request('http://127.0.0.1/graphql'));
  const tagged=new Request('http://127.0.0.1/graphql',{headers:{'x-loom-walkthrough-sql':'measure'}});
  const rows=await app.http.fetch(tagged);expect(seenRequest).toBe(tagged);return{status:200,body:{data:rows}};
 }};
 try{
  const result=await sqlRead({page,app,query:'{ tasks { id } }',match:/tasks/,task:'fictitious'});
  expect(result.body.data).toEqual([{id:'fictitious'}]);expect(result.statements).toHaveLength(1);expect(retained.all).toBe(retainedMethod);expect(Object.hasOwn(retained,'all')).toBe(false);expect(app.http.fetch).toBe(originalFetch);expect(db.prepare).toBe(originalPrepare);
  await expect(sqlRead({page:{evaluate:async()=>{throw Error('browser failed');}},app,query:'{}',match:/tasks/})).rejects.toThrow('browser failed');expect(app.http.fetch).toBe(originalFetch);expect(db.prepare).toBe(originalPrepare);
 }finally{db.close();}
});

it('installed socket observer forwards exact IO and does not record authentication frames',async()=>{
 const original=globalThis.WebSocket,previous=globalThis.__loomDataProbe;
 class Native extends EventTarget{static OPEN=1;readyState=1;constructor(url){super();this.url=url;}send(payload){this.sent=payload;}close(){this.readyState=3;}}
 try{
  globalThis.WebSocket=Native;await installDataProbe({addInitScript:async run=>run()});
  const socket=new WebSocket('ws://127.0.0.1/graphql'),state=globalThis.__loomDataProbe,entry=state.entries.get(socket);
  const auth=JSON.stringify({type:'connection_init',payload:{token:'fictitious-auth-never-retain'}});socket.send(auth);expect(socket.sent).toBe(auth);expect(entry.requests).toEqual([]);
  const subscribe=JSON.stringify({id:'q',type:'subscribe',payload:{query:'subscription { observe { revision } }',variables:{query:'{ tasks { id } }'}}});socket.send(subscribe);expect(socket.sent).toBe(subscribe);expect(entry.active.has('q')).toBe(true);
  let received;socket.addEventListener('message',event=>{received=event.data;});const incoming=JSON.stringify({id:'q',type:'next',payload:{data:{observe:{revision:1,patches:[{path:[],value:{tasks:[]}}]}}}});socket.dispatchEvent(new MessageEvent('message',{data:incoming}));expect(received).toBe(incoming);expect(entry.frames).toHaveLength(1);
  socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:'q',type:'error',payload:['rejected']})}));expect(entry.active.has('q')).toBe(false);
  expect(JSON.stringify({requests:entry.requests,frames:entry.frames})).not.toContain('fictitious-auth-never-retain');
  socket.close();expect(socket.readyState).toBe(3);
 }finally{globalThis.WebSocket=original;globalThis.__loomDataProbe=previous;}
});

it('keeps actual approved-promise mappings and classifies positive, negative and partial evidence',()=>{
 const pages=Object.fromEntries(['data','desk'].map(name=>[name,JSON.parse(readFileSync(new URL('../docs/rebuild-checklists/'+name+'.json',import.meta.url),'utf8'))]));
 for(const [page,id,action,success] of [['data','data-003','dataSelectionSQL','met'],['data','data-004','dataSharingSQL','not checkable yet'],['data','data-005','dataTaskPatches','not checkable yet'],['data','data-009','dataInboxChange','met'],['data','data-011','dataSharingSQL','not checkable yet'],['data','data-012','dataTaskPatches','not checkable yet'],['desk','desk-006','dataDoor','not checkable yet']]){
  const promise=pages[page].promises.find(p=>p.id===id);expect(promise.probe).toEqual({kind:'action',action});
  expect(evaluate(promise,{actions:{[action]:{ok:true,...(success==='met'?{}:{inconclusive:true})}}}).status).toBe(success);
  expect(evaluate(promise,{actions:{[action]:{ok:false,error:'Measured counterexample'}}}).status).toBe('not met');
  expect(evaluate(promise,{actions:{[action]:{inconclusive:true}}}).status).toBe('not checkable yet');
 }
});

it('waits for the active app selection data after a control changes its query',async()=>{
 const original=globalThis.WebSocket,previous=globalThis.__loomDataProbe;
 try{
  globalThis.WebSocket={OPEN:1};const socket={readyState:1,url:'ws://127.0.0.1/graphql'},entry={active:new Map([['fresh',{id:'fresh',query:'query Inbox { inboxItems { id } }'}]]),frames:[{id:'old'}]};
  globalThis.__loomDataProbe={sockets:[socket],entries:new Map([[socket,entry]])};let waited=false;
  const page={waitForFunction:async(fn,args)=>{expect(fn(args)).toBe(false);entry.frames.push({id:'fresh'});expect(fn(args)).toBe(true);waited=true;},evaluate:async(fn,args)=>{expect(waited).toBe(true);return fn(args);}};
  expect(await auditDataDoor(page,'Inbox')).toMatchObject({selectionSeen:true,graphql:1});
 }finally{globalThis.WebSocket=original;globalThis.__loomDataProbe=previous;}
});
