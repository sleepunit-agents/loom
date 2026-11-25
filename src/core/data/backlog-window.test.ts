import Database from 'better-sqlite3';
import {eq} from 'drizzle-orm';
import {expect,it} from 'vitest';
import {createDataSchema} from './database.js';
import {backlogWindow} from './backlog-window.js';
import * as s from './schema.js';

it('reconciles the starting cohort, new and reopened work, and movements using the reader’s current access',()=>{
  const client=new Database(':memory:');
  const start='2026-11-01T00:00:00.000Z', day=(n:number)=>start.replace('01T',String(n).padStart(2,'0')+'T');
  let at=start;
  try {
    const db=createDataSchema(client,()=>at);
    db.insert(s.members).values([{id:'sam',role:'member',joinedAt:at},{id:'lee',role:'member',joinedAt:at}]).run();
    db.insert(s.projects).values(['loom','pond'].map(id=>({id,name:id}))).run();
    db.insert(s.projectMembers).values([{project:'loom',member:'sam'},{project:'pond',member:'sam'}]).run();
    const add=(id:string,project:string,status:'closed'|'open'='open')=>db.insert(s.tasks).values({
      id,title:id,project,status,closedAt:status==='closed'?at:null,ownerKind:'member',owner:'sam',
      goal:'Finish',why:'Test',createdByKind:'member',createdBy:'sam',createdAt:at,changedAt:at,
    }).run();
    const close=(id:string)=>db.update(s.tasks).set({status:'closed',closedAt:at}).where(eq(s.tasks.id,id)).run();
    const move=(id:string,project:string)=>db.update(s.tasks).set({project}).where(eq(s.tasks.id,id)).run();
    at=day(2);
    for(const id of ['kept','done','moved'])add(id,'loom');
    add('from-pond','pond');add('old-closed','loom','closed');
    at=day(3);close('done');move('moved','pond');move('from-pond','loom');
    db.update(s.tasks).set({status:'open',closedAt:null}).where(eq(s.tasks.id,'old-closed')).run();
    add('new-open','loom');add('new-closed','loom');close('new-closed');
    const user={kind:'member' as const,id:'sam'};
    const read=(group?:string)=>backlogWindow(db,user,'loom',day(2),day(4),group)!;
    expect(Object.fromEntries(read().counts.map(c=>[c.key,c.total]))).toEqual({
      start:3,end:4,originalEverClosed:1,originalClosed:1,originalMovedOut:1,addedOpen:3,created:2,arrivalsClosed:1,reopened:1,movedIn:1,movedOut:1,
    });
    expect(read('originalMovedOut').tickets.map(t=>t.id)).toEqual(['moved']);
    expect(read('addedOpen').tickets.map(t=>t.id)).toEqual(['from-pond','new-open','old-closed']);
    expect(backlogWindow(db,user,'loom',day(2),day(4),'addedOpen',1,1)?.tickets).toEqual([{id:'new-open',title:'new-open'}]);
    expect(backlogWindow(db,{kind:'member',id:'lee'},'loom',day(2),day(4))).toBeNull();
    db.delete(s.projectMembers).where(eq(s.projectMembers.project,'pond')).run();
    expect(read('originalMovedOut').tickets).toEqual([]);
    expect(read().counts.find(c=>c.key==='start')?.total).toBe(2);
    expect(backlogWindow(db,user,'loom','2025-01-01T00:00:00.000Z',day(4))?.from).toBe(start);
  } finally {client.close();}
});
