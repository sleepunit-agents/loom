import {expect,it} from 'vitest';
import type {Task,Link} from '../tasks/domain.js';
import type {ProjectQuery} from './projects-roles.js';
import {taskGroups} from './projects-tasks.js';
const q:ProjectQuery={agent:'art',card:{slug:'pond',name:'Pond',status:'active',where:{},links:{epic:'t-epic'}},names:['pond','on-pond'],notePrefixes:['pond'],conversations:['cv-123456789abc'],since:'2026-11-06T00:00:00Z',now:Date.parse('2026-11-13T12:00:00Z')};
const task=(id:string,extra:Partial<Task>={}):Task=>({id,title:id,type:'task',status:'open',priority:2,createdAt:'2026-11-12T00:00:00Z',createdBy:'art',comments:[],...extra});
it('waits on assigned owner work without requiring an ask and preserves latest movement, plain prose and digest ids',()=>{
 const t=task('t-one',{assignee:'jonathan',goal:'Connect the teams.',why:'So field work is visible.',description:'x'.repeat(800)+' dg-123456789abc',comments:[{actor:'art',at:'2026-11-13T10:00:00Z',text:'Moved forward'}]});
 const groups=taskGroups([t],[{id:t.id,dependsOn:'t-epic',type:'parent-child'}],new Set(['t-one']),q,new Set(['jonathan']));
 expect(groups[0]).toMatchObject({title:'Waiting on you',waiting:true,items:[{when:'2026-11-13T10:00:00.000Z'}]});expect(groups[0].items[0].body).toContain('Connect the teams. So field work is visible.');expect(groups[0].items[0].body).toContain('dg-123456789abc');expect(groups[0].items[0].body!.length).toBeLessThanOrEqual(600);
});
it('shares the fifty-item limit across groups and labels truncation, retaining priority order',()=>{
 const tasks=Array.from({length:80},(_,i)=>task(`t-${i}`,{priority:i%4,assignee:i<20?'owner':undefined,status:i>=60?'closed':'open',closedAt:i>=60?'2026-11-12T00:00:00Z':undefined}));
 const links:Link[]=tasks.map(t=>({id:t.id,dependsOn:'t-epic',type:'parent-child'}));const ready=new Set(tasks.slice(20,40).map(t=>t.id));
 const groups=taskGroups(tasks,links,ready,q,new Set(['owner']));expect(groups.map(g=>g.items.length).reduce((a,b)=>a+b,0)).toBe(50);expect(groups).toHaveLength(4);expect(groups.every(g=>g.items.length>=12)).toBe(true);expect(groups[0].title).toContain('of 20');expect(groups[0].items[0].ref).toBe('t-0');
});
it('includes filed conversation tasks, excludes the epic itself and outside closed tasks',()=>{
 const groups=taskGroups([task('t-epic'),task('t-thread',{source:'conversation:cv-123456789abc'}),task('t-outside',{title:'Pond finished',status:'closed',closedAt:'2026-11-12T00:00:00Z'}),task('t-name',{title:'on-pond ready'})],[],new Set(['t-thread','t-name']),q,new Set());
 expect(groups.flatMap(g=>g.items).map(i=>i.ref)).toEqual(['t-thread','t-name']);
});
