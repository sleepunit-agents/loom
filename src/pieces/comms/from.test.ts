import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing } from '../../core/index.js';
import { installComms } from './index.js';
import { loadKey } from './crypto.js';
const cleanup:(()=>unknown)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(){
 const home=mkdtempSync(join(tmpdir(),'comms-from-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const key=await loadKey(home),clock=new FakeClock();
 const sharing:Sharing={members:{alice:{owner:false,agents:['art']},bob:{owner:true,agents:['art']},outsider:{owner:true,agents:[]}},projects:{},services:{}};
 let comms!:ReturnType<typeof installComms>;
 const app=await startLoom({home,clock,authenticate:req=>({viewer:{kind:'member',id:String(req.headers['x-member']??'alice')},window:req.headers['x-window']!=='no',valid:()=>true}),install:app=>{
  comms=installComms({...app,clock,key,sharing:()=>sharing,hold:run=>run(),runtime:{async deliver(){},async end(){}},attention:{answer:()=>({ok:true,value:{}})}});
 }});cleanup.push(app.close);cleanup.push(comms.close);
 const result=await app.operations.callAsync('socket',{kind:'member',id:'alice'},'comms.open',{agent:'art',id:'aaaaaaaaaaaaaaaa',text:'Private planted words'},'open',true);
 if(!result.ok)throw new Error('open failed');const thread=(result.value as {thread:string}).thread;
 await comms.deliver('art',thread,1);
 const row=()=>JSON.parse((app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record);
 const conversation=row().conversation as string;
 async function socket(member='alice',scope:string|null=conversation,window=true){
  const ws=new WebSocket(app.url.replace('http:','ws:')+'/live',{headers:{'x-member':member,'x-window':window?'yes':'no'}});
  const queue:any[]=[],waiters:((frame:any)=>void)[]=[];
  ws.on('message',raw=>{const frame=JSON.parse(raw.toString()),receive=waiters.shift();if(receive)receive(frame);else queue.push(frame);});
  const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise<any>(resolve=>waiters.push(resolve));
  await once(ws,'open');cleanup.push(()=>ws.terminate());ws.send(JSON.stringify({kind:'subscribe',type:'commsFrom',scope:scope??undefined}));return {next};
 }
 async function action(name:string,input:Record<string,unknown>={}){expect(await app.operations.callAsync('socket',{kind:'member',id:'alice'},'comms.change',{thread,action:name,...input},`action-${name}`,true)).toMatchObject({ok:true});}
 await comms.referencesReady;
 return {app,sharing,thread,conversation,row,socket,action,key};
}
it('returns a private link only to the original member, generic labels to everyone else',async()=>{
 const f=await setup();await f.action('title',{title:'Secret project title'});
 const own=await (await f.socket()).next();expect(own).toMatchObject({kind:'set',records:[{id:f.conversation,label:'From: Secret project title',url:`/p/comms-preview/thread/${f.thread.slice(3)}`}]});
 const other=await (await f.socket('bob')).next();expect(other).toMatchObject({records:[{id:f.conversation,label:'From a Comms thread'}]});
 const outsider=await (await f.socket('outsider')).next();expect(outsider).toMatchObject({records:[{id:f.conversation,label:'From a conversation'}]});
 for(const answer of [other,outsider]){expect(JSON.stringify(answer)).not.toContain(f.thread);expect(JSON.stringify(answer)).not.toMatch(/Secret project title|Private planted words|url/);}
 expect(await (await f.socket('alice','cv-other-venue')).next()).toMatchObject({records:[{label:'From a conversation'}]});
 expect(await (await f.socket('alice',null)).next()).toMatchObject({records:[]});
 expect(await (await f.socket('alice',f.conversation,false)).next()).toMatchObject({code:'denied'});
});
it('refreshes title, archive, ownership loss and deletion in two windows without decrypting words',async()=>{
 const f=await setup(),open=vi.spyOn(f.key,'open'),a=await f.socket(),b=await f.socket();
 for(const w of [a,b])expect(await w.next()).toMatchObject({records:[{label:'From: New thread with art'}]});
 await f.action('title',{title:'Current title'});
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'put',record:{label:'From: Current title'}});
 await f.action('archive');
 for(const w of [a,b])expect(await w.next()).toMatchObject({record:{label:'From: Current title'}});
 f.sharing.members.alice.agents=[];f.app.live.refreshAccess();
 for(const w of [a,b])expect(await w.next()).toMatchObject({records:[{id:f.conversation,label:'From a conversation'}]});
 f.sharing.members.alice.agents=['art'];f.app.live.refreshAccess();
 for(const w of [a,b])expect(await w.next()).toMatchObject({records:[{label:'From: Current title'}]});
 await f.action('delete');
 for(const w of [a,b])expect(await w.next()).toMatchObject({record:{id:f.conversation,label:'From a conversation'}});
 expect(open).not.toHaveBeenCalled();
});
for(const damage of ['ambiguous','relational','tombstone'] as const)it(`fails closed for ${damage} routing`,async()=>{
 const f=await setup(),t=f.row();
 if(damage==='ambiguous')f.app.db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run('th:duplicate',t.member,t.agent,null,JSON.stringify({...t,id:'th:duplicate'}));
 if(damage==='relational')f.app.db.prepare('UPDATE comms_threads SET member=? WHERE id=?').run('bob',f.thread);
 if(damage==='tombstone')f.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run(f.thread,t.member,t.agent,f.conversation,0);
 expect(await (await f.socket()).next()).toMatchObject({records:[{id:f.conversation,label:'From a conversation'}]});
});
