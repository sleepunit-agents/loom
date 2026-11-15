import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {connectionEvidence,changedFields,sqlRead} from './rebuild-data-actions.mjs';
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
 const inbox={patches:[{path:[],value:{inboxItems:[]}}]};
 expect(changedFields([inbox,{patches:[{path:['inboxItems',0],value:{id:'new'}}]}],1,'inboxItems',2)).toBe(true);
 expect(changedFields([inbox,{patches:[{path:['inboxItems'],value:[{id:'new'}]}]}],1,'inboxItems',2)).toBe(false);
});
it('observes tagged SQLite executions, preserves results and restores wrappers on success and failure',async()=>{
 const db=new Database(':memory:');db.exec('create table tasks(id text); insert into tasks values (\'fictitious\')');
 const originalPrepare=db.prepare;let seenRequest;
 const app={services:{comms:{db:{$client:db}}},http:{fetch:async request=>{seenRequest=request;return db.prepare('select id from tasks where id=?').all('fictitious');}}};
 const originalFetch=app.http.fetch;
 const page={evaluate:async()=>{
  await app.http.fetch(new Request('http://127.0.0.1/graphql'));
  const tagged=new Request('http://127.0.0.1/graphql',{headers:{'x-loom-walkthrough-sql':'measure'}});
  const rows=await app.http.fetch(tagged);expect(seenRequest).toBe(tagged);return{status:200,body:{data:rows}};
 }};
 try{
  const result=await sqlRead({page,app,query:'{ tasks { id } }',match:/tasks/,task:'fictitious'});
  expect(result.body.data).toEqual([{id:'fictitious'}]);expect(result.statements).toHaveLength(1);expect(app.http.fetch).toBe(originalFetch);expect(db.prepare).toBe(originalPrepare);
  await expect(sqlRead({page:{evaluate:async()=>{throw Error('browser failed');}},app,query:'{}',match:/tasks/})).rejects.toThrow('browser failed');expect(app.http.fetch).toBe(originalFetch);expect(db.prepare).toBe(originalPrepare);
 }finally{db.close();}
});
