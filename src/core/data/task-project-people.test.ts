import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {graphql} from 'graphql/index.js';
import {createDataSchema} from './database.js';
import {dataQueries} from './queries.js';
import {taskVisibility} from './visibility.js';
import type {Viewer} from '../../policy.js';
it('constrains project membership IDs at root and nested reads with current owner/member/agent SQL',async()=>{
 const client=new Database(':memory:');createDataSchema(client);
 try{
  client.exec(`INSERT INTO members(id,role,joined_at) VALUES ('sam','member','2026-11-15T00:00:00.000Z'),('lee','member','2026-11-15T00:00:00.000Z'),('pat','owner','2026-11-15T00:00:00.000Z');
   INSERT INTO agents(id,about,mark_bg,mark_fg,face_shape,face_eyes) VALUES ('art','','#000','#fff','pebble','dot');
   INSERT INTO projects(id,name) VALUES ('pond','Pond'),('hidden','Hidden');
   INSERT INTO project_members(project,member) VALUES ('pond','sam'),('pond','lee'),('hidden','lee');
   INSERT INTO project_agents(project,agent) VALUES ('pond','art');`);
  const schema=(viewer:Viewer)=>dataQueries(client,{tables:['projects','projectMembers'],visibility:taskVisibility(viewer)});
  const sam=schema({kind:'member',id:'sam'}),pat=schema({kind:'member',id:'pat'}),art=schema({kind:'agent',id:'art'});
  const source='{ projectMembers { project member } projects { id projectMembersByProject { member projectRow { id } } } }';
  const read=async(current:ReturnType<typeof schema>)=>{const result=await graphql({schema:current,source});expect(result.errors).toBeUndefined();if(result.data?.projectMembers) (result.data.projectMembers as {member:string}[]).sort((a,b)=>a.member.localeCompare(b.member));return result.data;};
  const visible={projectMembers:[{project:'pond',member:'lee'},{project:'pond',member:'sam'}],projects:[{id:'pond',projectMembersByProject:[{member:'lee',projectRow:{id:'pond'}},{member:'sam',projectRow:{id:'pond'}}]}]};
  expect(await read(sam)).toEqual(visible);expect(await read(art)).toEqual(visible);
  // Independent parent predicate catches a missing connected edge constraint.
  const connected=dataQueries(client,{tables:['members','projectMembers'],visibility:{...taskVisibility({kind:'member',id:'sam'}),members:f=>sql`${f.id} = 'lee'`}});
  const parentRead=await graphql({schema:connected,source:'{ members { id projectMembersByMember { project } } }'});
  expect(parentRead.errors).toBeUndefined();expect(parentRead.data).toEqual({members:[{id:'lee',projectMembersByMember:[{project:'pond'}]}]});
  const selfOnly=dataQueries(client,{tables:['members','projectMembers'],visibility:{...taskVisibility({kind:'member',id:'sam'}),members:f=>sql`${f.id} = 'sam'`}});
  const roleRead=await graphql({schema:selfOnly,source:'{ projectMembers { member memberRow { id role } } }'});
  expect(roleRead.errors).toBeUndefined();expect(roleRead.data?.projectMembers).toEqual(expect.arrayContaining([{member:'lee',memberRow:null},{member:'sam',memberRow:{id:'sam',role:'member'}}]));

  expect((await read(pat))?.projectMembers).toHaveLength(3);
  client.exec("DELETE FROM project_members WHERE member='sam'");
  expect(await read(sam)).toEqual({projectMembers:[],projects:[]});
  client.exec("DELETE FROM project_agents");expect(await read(art)).toEqual({projectMembers:[],projects:[]});
  client.exec("UPDATE members SET role='member' WHERE id='pat'");expect(await read(pat)).toEqual({projectMembers:[],projects:[]});
  client.exec("INSERT INTO project_members(project,member) VALUES ('pond','sam')");expect(await read(sam)).toEqual(visible);
  expect(await read(schema({kind:'service',id:'outside'}))).toEqual({projectMembers:[],projects:[]});
 }finally{client.close();}
});
