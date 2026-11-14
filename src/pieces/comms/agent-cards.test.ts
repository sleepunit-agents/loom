import {once} from 'node:events';
import {WebSocket} from 'ws';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startLoom} from '../../foundation.js';
import {HouseholdDatabase} from '../../core/household/document.js';
import {fixture,installFixture} from '../../fixture.js';
import {FakeClock,type Sharing,type Viewer} from '../../core/index.js';
const cleanup:(()=>unknown)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(){
 const home=mkdtempSync(join(tmpdir(),'agent-chips-'));fixture(home);cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const sharing:Sharing={members:{jonathan:{owner:false,agents:['art','mark']},other:{owner:true,agents:['art']}},projects:{pond:{members:['jonathan'],agents:['pond-bot']}},services:{}};
 const app=await startLoom({home,next:true,staging:true,clock:new FakeClock(),stdout:()=>{},sharing:()=>sharing,install:installFixture,authenticate:()=>({viewer:{kind:'member',id:'jonathan'},window:true,valid:()=>true})});cleanup.push(app.close);
 let n=0;const viewer:Viewer={kind:'member',id:'jonathan'};
 const call=(name:string,input:unknown)=>app.operations.callAsync('socket',viewer,name,input,`agent-card-${++n}`,true);
 const opened=await call('comms.open',{agent:'art',id:'aaaaaaaaaaaaaaaa',text:'Source words'});if(!opened.ok)throw new Error('open failed');
 const thread=(opened.value as {thread:string}).thread;
 return {app,home,sharing,call,thread,viewer};
}
it('uses the real household profile and owning Agents roster, never project-only or old-file metadata',async()=>{
 const s=await setup();
 writeFileSync(join(s.home,'household.json'),JSON.stringify({agents:['ghost'],about:{ghost:'Old private description'}}));
 new HouseholdDatabase(s.app.db).change(s.home,raw=>{raw.about={art:'Installed private profile words',mark:'Other private profile words'};});
 s.sharing.members.jonathan.agents.push('ghost');
 const answer=await s.call('comms.refCards',{thread:s.thread,refs:['agent:art','at:art','agent:mark','at:pond-bot','agent:ghost','agent:Art','at:../art']});
 expect(answer).toEqual({ok:true,value:{thread:s.thread,cards:{'agent:art':{kind:'agent',title:'art',status:'Agent',url:'/p/agents-preview/agent/art'},'at:art':{kind:'agent',title:'art',status:'Agent',url:'/p/agents-preview/agent/art'},'agent:mark':{kind:'agent',title:'mark',status:'Agent',url:'/p/agents-preview/agent/mark'},'at:pond-bot':null,'agent:ghost':null,'agent:Art':null,'at:../art':null}}});
 expect(JSON.stringify(answer)).not.toContain('Old private description');
 const original=s.app.operations.call.bind(s.app.operations),seen:string[]=[],people=vi.fn();
 let profileResult:ReturnType<typeof s.app.operations.call>={ok:false,code:'denied',message:'Private rejected words'};
 const spy=vi.spyOn(s.app.operations,'call').mockImplementation((door,viewer,name,input,id,window)=>{
  if(name==='household.profile'){seen.push(viewer.id);return profileResult;}
  if(name==='mind.personRead'){people();return {ok:true,value:{id:'commons:mark',slug:'mark',name:'Private directory name',kind:'agent',card:{summary:'Private directory data'}}};}
  return original(door,viewer,name,input,id,window);
 });
 try{
  for(const response of [{ok:false,code:'denied',message:'Private rejected words'},{ok:true,value:{}},{ok:true,value:{agent:42}},{ok:true,value:{agent:'wrong'}}] as ReturnType<typeof s.app.operations.call>[]){
   profileResult=response;
   expect(await s.call('comms.refCards',{thread:s.thread,refs:['at:mark','agent:mark']})).toEqual({ok:true,value:{thread:s.thread,cards:{'at:mark':null,'agent:mark':null}}});
  }
  profileResult={ok:true,value:{agent:'mark',description:'Private profile data'}};
  const card={kind:'agent',title:'mark',status:'Agent',url:'/p/agents-preview/agent/mark'};
  expect(await s.call('comms.refCards',{thread:s.thread,refs:['at:mark','agent:mark']})).toEqual({ok:true,value:{thread:s.thread,cards:{'at:mark':card,'agent:mark':card}}});
  expect(seen).toEqual(Array(10).fill('jonathan'));expect(people).not.toHaveBeenCalled();
 }finally{spy.mockRestore();}
});
it('withdraws target agent and at cards independently of source access in two windows',async()=>{
 const s=await setup(),scope=JSON.stringify({thread:s.thread,refs:['agent:mark','at:mark']});
 s.sharing.members.jonathan.owner=true;
 interface Frame{kind:string;[key:string]:unknown}
 async function window(){
  const ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live'),queue:Frame[]=[],waiters:((v:Frame)=>void)[]=[];
  ws.on('message',raw=>{const v=JSON.parse(raw.toString()) as Frame,next=waiters.shift();if(next)next(v);else queue.push(v);});
  const next=()=>queue.length?Promise.resolve(queue.shift()!):new Promise<Frame>(r=>waiters.push(r));
  await once(ws,'open');cleanup.push(()=>ws.terminate());ws.send(JSON.stringify({kind:'subscribe',type:'comms.refCards',scope}));return {next};
 }
 const a=await window(),b=await window();
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'set',records:[{cards:{'agent:mark':{kind:'agent'},'at:mark':{kind:'agent'}}}]});
 s.sharing.members.jonathan.agents=['art'];
 expect(s.app.operations.call('direct',s.viewer,'household.profile',{agent:'mark'})).toEqual({ok:true,value:{agent:'mark'}});
 s.app.live.refreshAccess();
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'set',records:[{cards:{'agent:mark':null,'at:mark':null}}]});
 s.sharing.members.jonathan.agents.push('mark');s.app.live.refreshAccess();
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'set',records:[{cards:{'agent:mark':{kind:'agent'},'at:mark':{kind:'agent'}}}]});
});
