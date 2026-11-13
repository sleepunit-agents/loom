import { it,expect } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { fixture,installFixture } from '../fixture.js';
import { tasksRole } from '../pieces/tasks/role.js';
import { taskFor,taskWork,projectTasks } from './task-work.js';
it('unmoved Comms and Projects get current task content through the role and retain its project policy',async()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-task-work-'));fixture(home);
  const app=await startLoom({home,clock:new FakeClock(),install:installFixture});
  const tasks=tasksRole(app.operations);
  try {
    expect(taskFor(tasks,'pollock','t-1')?.title).toBe('Pond work');
    expect(taskFor(tasks,'pollock','t-2')).toBeUndefined();
    expect(taskFor(tasks,'jonathan','t-2')?.title).toBe('Other project work');
    expect(taskWork(tasks,'pollock','cv-example',['t-1','t-2']).map(t=>t.ref)).toEqual(['t-1']);
    const created=tasks.call({kind:'member',id:'jonathan'},'create',{title:'Made in this thread',goal:'Useful work is visible',why:'Keep context',project:'pond',source:'conversation:cv-example',cli:true},'native-create');
    expect(created.ok).toBe(true);
    const id=(created as any).value.result.id;
    expect(taskWork(tasks,'pollock','cv-example',[])).toEqual([expect.objectContaining({ref:id,made:true,title:'Made in this thread',url:`/p/tasks/task/${id}`})]);
    tasks.call({kind:'member',id:'jonathan'},'close',{id,reason:'Done',cli:true},'native-close');
    expect(taskWork(tasks,'pollock','cv-example',[])[0].status).toBe('Done');
    const section=projectTasks(tasks,'pollock','pond',undefined,'2026-11-01T00:00:00Z');
    const refs=section.groups.flatMap(g=>g.items.map(i=>i.ref));
    expect(refs).toContain('t-1');expect(refs).toContain(id);expect(refs).not.toContain('t-2');expect(refs).not.toContain('t-4');
  } finally {await app.close();rmSync(home,{recursive:true,force:true});}
});
