/** Protocol capacity fixture. Owning HTTP/Signin/source/worker composition is
 * covered separately by runtime-runner/clock-worker.test.ts. */
import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFoundation} from '../../core/app.js';
import {installEffects} from '../../core/effects.js';
import {FakeClock} from '../../core/clock.js';
import {fixtureSharing} from '../../fixture.js';
import {installClockExecution,type ClockExecutionInput} from './clock-execution.js';
import {clockExecutionAdmission} from './clock-protocol.js';
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});
it('bounds all retained sources across multiple chains and releases expired capacity',async()=>{
 const home=mkdtempSync(join(tmpdir(),'clock-execution-capacity-'));cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock(),app=createFoundation({home,clock});cleanups.push(app.close);
 const effects=installEffects(app,fixtureSharing,false);
 let selected:ClockExecutionInput,prepared=0,n=0;
 installClockExecution(app,effects,()=>{prepared++;return selected;});
 const call=(name:string,input:unknown)=>app.operations.callAsync('direct',{kind:'agent',id:'art'},`runtime.${name}`,input,`capacity-${++n}`);
 const source=(chain:number,index:number):ClockExecutionInput=>{
  let consumed=false;
  return {historyKey:'a'.repeat(64),job:`job-${chain}`,
   assignment:{runner:'a',box:'a',claimedAt:clock.now(),house:{repo:'/fixture/art',houseFile:'house/house.json'}},
   binding:{agent:'art',conversation:`chain-${chain}`,venue:'wake',place:`place-${chain}`},
   message:{id:`clock:capacity-${chain}-${index}`,seq:index+1,kind:'wake',text:'fixture'},
   current:(_viewer,completed=false)=>consumed===completed,
   retainedCurrent:()=>consumed,acknowledge:()=>{consumed=true;},more:()=>true};
 };
 // Eleven map entries retain 1024 separate sources. Counting only map entries
 // would admit source 1025, even though the actual retained-source bound is full.
 for(let chain=0;chain<11;chain++){
  let previous:string|undefined;
  for(let index=0;index<(chain===10?24:100);index++){
   selected=source(chain,index);
   const answer=await call('beginClockExecution',previous?{previous}:{});expect(answer).toMatchObject({ok:true});
   if(!answer.ok)throw new Error('capacity fixture admission failed');
   previous=clockExecutionAdmission.parse(answer.value).execution;
   expect(await call('completeClockExecution',{execution:previous})).toMatchObject({ok:true,value:{acknowledged:true,more:true}});
  }
 }
 expect(prepared).toBe(1024);selected=source(11,0);
 expect(await call('beginClockExecution',{})).toMatchObject({ok:false,code:'unavailable'});expect(prepared).toBe(1024);
 expect(effects.status('runtime:clock-native:clock:capacity-11-0')).toBeUndefined();
 clock.advance(30*60_000);
 expect(await call('beginClockExecution',{})).toMatchObject({ok:true});expect(prepared).toBe(1025);
},20_000);
