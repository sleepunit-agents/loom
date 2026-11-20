import {expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {join} from 'node:path';
import {sharedUiProgram} from '../test/fixtures/shared-ui-program.js';
import {startSharedHome} from './shared-startup.js';
import {FakeClock} from './core/clock.js';
import * as s from './core/data/schema.js';
it('restarts with an existing Notes source byte-for-byte and refuses to prepare it implicitly',async()=>{
 const clock=new FakeClock(Date.now()),p=await sharedUiProgram({clock,seed(db,now){db.insert(s.members).values({id:'alice',role:'owner',joinedAt:now()}).run();db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();}});let restarted:Awaited<ReturnType<typeof startSharedHome>>|undefined;
 try{
  const credential=p.composition.writes.run(()=>p.composition.services.signin.issue({kind:'agent',agent:'art',label:'Fictional Notes restart'})).value;
  const write=(url:string,id:string)=>fetch(url+'/api/memory/noteWrite',{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},body:JSON.stringify({input:{path:'fictional/precious',body:'FICTIONAL_PRECIOUS_EXISTING_NOTE',lifespan:'keep'},id})});expect((await write(p.url,'notes-first')).status).toBe(200);
  await p.composition.close();const file=join(p.home,'agents/art/notes.db'),source=new Database(file);source.exec('DROP TABLE mind_operation_receipts; DROP TABLE mind_source_migrations');const before=source.serialize();source.close();
  restarted=await startSharedHome({home:p.home,clock,host:'127.0.0.1',port:0,stdout(){}});
  const snapshot=()=>{const db=new Database(file,{readonly:true,fileMustExist:true});try{return db.serialize();}finally{db.close();}};expect(snapshot()).toEqual(before);
  expect((await write(restarted.url,'notes-unprepared')).status).toBe(503);expect(snapshot()).toEqual(before);
  const read=await fetch(restarted.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},body:JSON.stringify({query:'{memoryNote(agent:"art",path:"fictional/precious"){body}}'})});expect(await read.json()).toEqual({data:{memoryNote:{body:'FICTIONAL_PRECIOUS_EXISTING_NOTE'}}});expect(snapshot()).toEqual(before);
 }finally{await restarted?.close();await p.close();}
});

it('atomically chooses one claimant and fences the former holder after takeover',async()=>{
 const p=await sharedUiProgram({clock:new FakeClock(Date.now()),seed(db,now){
  db.insert(s.members).values({id:"alice",role:"owner",joinedAt:now()}).run();
  db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 }});
 try{
  const credential=p.composition.writes.run(()=>p.composition.services.signin.issue({kind:'agent',agent:'art',label:'Fictional lane'})).value;
  const write=async(id:string,expectedBody:string|null,body:string)=>{
   const response=await fetch(p.url+'/api/memory/noteWrite',{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},
    body:JSON.stringify({id,input:{path:'lanes/fictional',lifespan:'keep',expectedBody,body}})});
   return response.status;
  };
  const claims=await Promise.all([write('claim-a',null,'a'),write('claim-b',null,'b')]);
  expect([...claims].sort()).toEqual([200,409]);
  const holder=claims[0]===200?'a':'b';
  expect(await write('takeover',holder,'c')).toBe(200);
  expect(await write('stale-completion',holder,'stale checkpoint')).toBe(409);
  expect(await write('finish','c','next checkpoint')).toBe(200);
  expect(await write('finish','c','next checkpoint')).toBe(200);
 }finally{await p.close();}
});
