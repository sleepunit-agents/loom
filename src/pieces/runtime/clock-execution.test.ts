/** Remaining legacy protocol capacity fixture, until its bootstrap is retired. */
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

it('idle retention is clipped to the original execution expiry, even after a late completion',async()=>{
 const home=mkdtempSync(join(tmpdir(),'clock-idle-expiry-'));cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock(),app=createFoundation({home,clock});cleanups.push(app.close);
 const effects=installEffects(app,fixtureSharing,false);let consumed=false,prepared=0,n=0;
 const input:ClockExecutionInput={historyKey:'b'.repeat(64),job:'job-expiry',
  assignment:{runner:'a',box:'a',claimedAt:clock.now(),house:{repo:'/fixture/art',houseFile:'house/house.json'}},
  binding:{agent:'art',conversation:'expiry-chain',venue:'wake',place:'expiry-place'},
  message:{id:'clock:expiry-0',seq:1,kind:'wake',text:'fixture'},
  current:(_viewer,completed=false)=>consumed===completed,retainedCurrent:()=>consumed,
  acknowledge:()=>{consumed=true;},more:()=>false};
 installClockExecution(app,effects,()=>{prepared++;return input;});
 const call=(name:string,value:unknown)=>app.operations.callAsync('direct',{kind:'agent',id:'art'},`runtime.${name}`,value,`expiry-${++n}`);
 const admission=await call('beginClockExecution',{});expect(admission).toMatchObject({ok:true});
 if(!admission.ok)throw new Error('expiry admission failed');
 const execution=clockExecutionAdmission.parse(admission.value).execution;
 clock.advance(30*60_000-2000);
 expect(await call('completeClockExecution',{execution,idleMs:30_000})).toMatchObject({ok:true,value:{more:false}});
 clock.advance(1999);expect(await call('idleClockExecution',{execution})).toMatchObject({ok:true});
 clock.advance(1);expect(await call('idleClockExecution',{execution})).toMatchObject({ok:false,code:'denied'});
 expect(await call('beginClockExecution',{previous:execution})).toMatchObject({ok:false,code:'denied'});
 expect(prepared).toBe(1);
});

it('joined turns inherit the first admission deadline without inheriting the shorter idle expiry',async()=>{
 const home=mkdtempSync(join(tmpdir(),'clock-chain-deadline-'));cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock(),app=createFoundation({home,clock});cleanups.push(app.close);
 const effects=installEffects(app,fixtureSharing,false);let n=0,index=0;
 const consumed=new Set<number>();
 installClockExecution(app,effects,()=>{
  const selected=index++;
  return {historyKey:'c'.repeat(64),job:'chain-job',
   assignment:{runner:'a',box:'a',claimedAt:0,house:{repo:'/fixture/art',houseFile:'house/house.json'}},
   binding:{agent:'art',conversation:'chain',venue:'wake',place:'chain'},
   message:{id:`clock:deadline-${selected}`,seq:selected+1,kind:'wake',text:'fixture'},
   current:(_viewer,completed=false)=>consumed.has(selected)===completed,retainedCurrent:()=>consumed.has(selected),
   acknowledge:()=>{consumed.add(selected);},more:()=>false};
 });
 const call=(name:string,input:unknown)=>app.operations.callAsync('direct',{kind:'agent',id:'art'},`runtime.${name}`,input,`chain-deadline-${++n}`);
 const admit=async(previous?:string)=>{
  const result=await call('beginClockExecution',previous?{previous}:{});expect(result).toMatchObject({ok:true});
  if(!result.ok)throw new Error('chain admission failed');return clockExecutionAdmission.parse(result.value);
 };
 const first=await admit();expect(first.lifetime).toBe(1_800_000);
 clock.advance(1000);
 expect(await call('completeClockExecution',{execution:first.execution,idleMs:30_000})).toMatchObject({ok:true});
 clock.advance(1000);const second=await admit(first.execution);expect(second.lifetime).toBe(1_798_000);
 // The first idle window ended, but the admitted active successor remains valid.
 clock.advance(30_000);expect(await call('currentClockExecution',{execution:second.execution})).toMatchObject({ok:true});
 expect(await call('completeClockExecution',{execution:second.execution,idleMs:30_000})).toMatchObject({ok:true});
 const third=await admit(second.execution);expect(third.lifetime).toBe(1_768_000);
 clock.advance(1_767_999);expect(await call('currentClockExecution',{execution:third.execution})).toMatchObject({ok:true});
 clock.advance(1);expect(await call('currentClockExecution',{execution:third.execution})).toMatchObject({ok:false,code:'denied'});
 expect(await call('completeClockExecution',{execution:third.execution})).toMatchObject({ok:false,code:'denied'});
 expect(consumed).toEqual(new Set([0,1]));
});
