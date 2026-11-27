import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {createDataSchema} from './database.js';
import {workBoardFields} from './work-board.js';
import * as s from './schema.js';

it('gives each card of a project board its priority and assignee, to a reader of the project and to no one else',()=>{
  const client=new Database(':memory:');
  const at='2026-11-01T00:00:00.000Z';
  try {
    const db=createDataSchema(client,()=>at);
    db.insert(s.members).values([{id:'sam',role:'member',joinedAt:at},{id:'lee',role:'member',joinedAt:at}]).run();
    db.insert(s.projects).values({id:'loom',name:'Loom'}).run();
    db.insert(s.projectMembers).values({project:'loom',member:'sam'}).run();
    const add=(id:string,priority:number,over:Partial<typeof s.tasks.$inferInsert>={})=>db.insert(s.tasks).values({
      id,title:id,project:'loom',priority,ownerKind:'member',owner:'sam',goal:'Finish',why:'Test',
      createdByKind:'member',createdBy:'sam',createdAt:at,changedAt:at,...over}).run();
    add('t-1',3,{status:'in_progress',assigneeKind:'member',assignee:'sam'});
    add('t-2',0,{status:'in_progress',assigneeKind:'member',assignee:'sam'});
    add('t-3',1,{ask:'Which pump?',assigneeKind:'member',assignee:'sam'});
    add('t-4',2);
    add('t-5',4,{status:'closed',closedAt:at,closeReason:'done'});
    const field=workBoardFields(db).projectBoardTickets;
    const read=(id:string,args:object={})=>field.resolve!(undefined,{project:'loom',finished:false,offset:0,limit:51,...args},{viewer:{kind:'member',id}},undefined as never) as Record<string,unknown>[];
    // Active cards, most urgent first; an open ticket nobody works and nothing waits on is in no lane.
    expect(read('sam')).toEqual([
      {id:'t-2',title:'t-2',project:'loom',assignee:'sam',priority:0,lane:'Working',reason:null},
      {id:'t-3',title:'t-3',project:'loom',assignee:'sam',priority:1,lane:'Waiting',reason:'Which pump?'},
      {id:'t-1',title:'t-1',project:'loom',assignee:'sam',priority:3,lane:'Working',reason:null},
    ]);
    expect(read('sam',{finished:true})).toEqual([{id:'t-5',title:'t-5',project:'loom',assignee:null,priority:4,lane:'Finished',reason:'Ticket closed'}]);
    expect(read('lee')).toEqual([]);
    expect(read('lee',{finished:true})).toEqual([]);
  } finally {client.close();}
});
