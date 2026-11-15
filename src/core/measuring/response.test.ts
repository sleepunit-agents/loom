import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createMeasuring, DEFAULT_MEASURING, type TimingDay } from './index.js';
import { FakeClock } from '../clock.js';
import { measureResponse } from './response.js';
it('does not classify, allocate a span or observe response events while off',()=>{
 const runAsync=vi.fn();const response={once(){throw Error('event observed');},off(){throw Error('event observed');}};
 const request={get url():string{throw Error('request classified');}};const work=vi.fn();
 expect(measureResponse({enabled:()=>false,runAsync},request,response,work)).toBeUndefined();
 expect(work).toHaveBeenCalledOnce();expect(runAsync).not.toHaveBeenCalled();
});
it.each(['finish','close'] as const)('retains timing until response %s, independent of dispatch completion',async event=>{
 const rows:TimingDay[]=[];const meter=await createMeasuring({...DEFAULT_MEASURING,on:true},[{kind:'request',name:'graphql'}],{add:r=>{rows.push(r);},prune(){}},undefined,new FakeClock(Date.UTC(2026,10,14)));
 const response=new EventEmitter();
 try {const sent=measureResponse({...meter,enabled:()=>true},{url:'/graphql?private'},response,()=>{});expect(rows).toEqual([]);response.emit(event);await sent;expect(rows).toEqual([expect.objectContaining({kind:'request',name:'graphql',count:1})]);expect(response.listenerCount('finish')+response.listenerCount('close')).toBe(0);}
 finally {await meter.close();}
});
