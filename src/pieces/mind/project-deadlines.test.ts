import {expect,it,vi} from 'vitest';
import {projectDeadline} from './project-deadlines.js';
import {QueryDeadlines} from './query-deadlines.js';
import type {ProjectRecord} from './projects-model.js';
it('coalesces new result metadata, keeps independent selections and cancels queued notification on close',async()=>{
 let now=0;const deadlines=new QueryDeadlines(()=>now),changed=vi.fn(),off=deadlines.observe(changed);
 deadlines.set('owner',20);deadlines.set('peer',10);expect(deadlines.nextDeadline()).toBe(10);await Promise.resolve();expect(changed).toHaveBeenCalledOnce();
 now=10;expect(deadlines.nextDeadline()).toBe(20);deadlines.set('peer',30);await Promise.resolve();expect(deadlines.nextDeadline()).toBe(20);
 deadlines.set('owner',undefined);await Promise.resolve();expect(deadlines.nextDeadline()).toBe(30);
 deadlines.set('invalid',NaN);expect(deadlines.nextDeadline()).toBe(30);off();changed.mockClear();deadlines.set('pending',15);deadlines.close();await Promise.resolve();expect(changed).not.toHaveBeenCalled();expect(deadlines.nextDeadline()).toBeUndefined();
});
it('finds card age, staleness, section expiry and seven-day activity boundaries',()=>{
 const day=86400000,now=Date.parse('2026-11-14T18:00:00Z');
 const r={card:{where:{hose:{value:'Fiction',verified_at:new Date(now-14*day+1000).toISOString()}}},sections:[{key:'notes',label:'Notes',available:true,expires:now+2000,activity:new Date(now-7*day+3000).toISOString(),groups:[{title:'Work',items:[{title:'Fiction',when:new Date(now-day+4000).toISOString(),changed:new Date(now-7*day+5000).toISOString()}]}]}]} as ProjectRecord;
 expect(projectDeadline(r,now)).toBe(now+1000);expect(projectDeadline(r,now+1000)).toBe(now+1001);expect(projectDeadline(r,now+1001)).toBe(now+2000);expect(projectDeadline(r,now+2000)).toBe(now+3000);expect(projectDeadline(r,now+3000)).toBe(now+4000);expect(projectDeadline(r,now+4000)).toBe(now+5000);
});
