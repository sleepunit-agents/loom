import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from './database.js';
import { agents, members, projects, projectMembers } from './schema.js';
import { Conversations } from '../conversations/index.js';
import { sharedProjectSections } from '../../shared-memory-projects.js';
import type { ProjectQuery } from '../../pieces/mind/projects-roles.js';
const clients: Database.Database[]=[];
afterEach(()=>{for(const client of clients.splice(0))client.close();});
it('bounds the Project hub conversation section at two and ten rows and rechecks scope before counting',()=>{
 const statements:string[]=[],client=new Database(':memory:',{verbose:s=>statements.push(s)});clients.push(client);
 const now='2026-11-14T18:00:00.000Z',db=createDataSchema(client,()=>now);
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:now},{id:'peer',role:'member',joinedAt:now}]).run();
 db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(projects).values({id:'pond',name:'Pond'}).run();db.insert(projectMembers).values({project:'pond',member:'peer'}).run();
 const mail=new Conversations(db,()=>now),section=sharedProjectSections(db).conversations;
 const query={names:['pond'],card:{links:{venues:[]}}} as unknown as ProjectQuery;
 const viewer={kind:'member' as const,id:'peer'};let small=0;
 for(let n=0;n<10;n++){
  const cv=mail.open({agent:'art',project:'pond',venue:'loom',place:'growth-'+n,label:'Visible '+n});
  mail.turn({conversation:cv.id,kind:'reply',fromKind:'agent',fromId:'art'});
  if(n===1){statements.length=0;expect(section.read(viewer,query)).toMatchObject({total:2,items:[{who:['art']},{who:['art']}]});small=statements.length;}
 }
 const hidden=mail.open({agent:'art',project:'pond',member:'owner',venue:'loom',place:'private',label:'PRIVATE'});
 statements.length=0;const result=section.read(viewer,query);expect(result.total).toBe(10);expect(JSON.stringify(result)).not.toContain(hidden.id);expect(statements.length).toBe(small);expect(small).toBe(2);
 db.delete(projectMembers).where(eq(projectMembers.member,'peer')).run();expect(section.read(viewer,query)).toMatchObject({total:0,items:[]});
 expect(section.read({kind:'member',id:'owner'},query).total).toBe(11);
});

it('keeps the fifty participant previews per card and every visible matching ID',()=>{
 const statements:string[]=[], client=new Database(':memory:',{verbose:s=>statements.push(s)});
 clients.push(client);
 const now='2026-11-14T18:00:00.000Z', db=createDataSchema(client,()=>now);
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:now},{id:'peer',role:'member',joinedAt:now}]).run();
 db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(projects).values({id:'pond',name:'Pond'}).run();
 db.insert(projectMembers).values({project:'pond',member:'peer'}).run();
 const mail=new Conversations(db,()=>now);
 const opened=Array.from({length:52},(_,i)=>{
  const c=mail.open({agent:'art',project:'pond',venue:'loom',place:'room-'+i,label:'Room '+i});
  mail.turn({conversation:c.id,kind:'reply',fromKind:'agent',fromId:'art'});
  return c;
 }).sort((a,b)=>a.id<b.id?-1:1);
 const last=opened[51]!;
 const hidden=mail.open({agent:'art',project:'pond',member:'owner',venue:'loom',place:'private',label:'Hidden'});
 const q=(names:string[],venues:string[])=>({names,card:{links:{venues}}} as unknown as ProjectQuery);
 const all=q(['alias','pond'],['loom:'+last.id]);
 const subset=q([],['loom:'+last.id,'loom:'+last.place,'loom:'+hidden.id]);
 const role=sharedProjectSections(db).conversations;
 statements.length=0;
 const read=role.prepareForList!({kind:'member',id:'peer'},[all,subset]);
 const full=read(all);
 expect(full.conversationIds).toEqual(opened.map(c=>c.id));
 expect(full.items).toHaveLength(50);
 expect(read(subset)).toMatchObject({total:1,conversationIds:[last.id],items:[{ref:last.id,who:['art']}]});
 expect(statements).toHaveLength(2);
 db.delete(projectMembers).where(eq(projectMembers.member,'peer')).run();
 expect(role.read({kind:'member',id:'peer'},subset)).toMatchObject({total:0,items:[]});
});
