import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {createDataSchema} from './database.js';
import {members,agents,memberAgents,projects,projectMembers,projectAgents} from './schema.js';
import {sharedSharing,canReadSharedConversation} from '../../shared-sharing.js';
import {Conversations} from '../conversations/index.js';
const clients:Database.Database[]=[];afterEach(()=>{for(const c of clients.splice(0))c.close();});
it('reads current household policy facts in five generated batches at two and ten rows',()=>{
 const sql:string[]=[],client=new Database(':memory:',{verbose:s=>sql.push(s)});clients.push(client);
 const now='2026-11-14T18:00:00.000Z',db=createDataSchema(client,()=>now);let small=0;
 for(let n=0;n<10;n++){
  db.insert(members).values({id:'member-'+n,role:n===0?'owner':'member',joinedAt:now}).run();
  db.insert(agents).values({id:'agent-'+n,about:'PRIVATE ABOUT',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
  db.insert(memberAgents).values({member:'member-'+n,agent:'agent-'+n}).run();db.insert(projects).values({id:'project-'+n,name:'PRIVATE PROJECT NAME'}).run();
  db.insert(projectMembers).values({project:'project-'+n,member:'member-'+n}).run();db.insert(projectAgents).values({project:'project-'+n,agent:'agent-'+n}).run();
  if(n===1||n===9){sql.length=0;const sharing=sharedSharing(db);expect(sharing.members['member-'+n]).toEqual({owner:false,agents:['agent-'+n]});expect(sharing.projects['project-'+n]).toEqual({members:['member-'+n],agents:['agent-'+n]});expect(JSON.stringify(sharing)).not.toContain('PRIVATE');if(n===1)small=sql.length;else expect(sql.length).toBe(small);}
 }
 expect(small).toBe(5);
 const mail=new Conversations(db,()=>now),cv=mail.open({agent:'agent-1',project:'project-1',venue:'loom',place:'scope',label:'PRIVATE LABEL'});
 const viewer={kind:'member' as const,id:'member-1'};expect(canReadSharedConversation(db,viewer,cv.id)).toBe(true);
 db.delete(projectMembers).where(eq(projectMembers.member,'member-1')).run();db.delete(memberAgents).where(eq(memberAgents.member,'member-1')).run();expect(canReadSharedConversation(db,viewer,cv.id)).toBe(false);
 expect(canReadSharedConversation(db,{kind:'member',id:'member-0'},cv.id)).toBe(true);db.update(members).set({role:'member'}).where(eq(members.id,'member-0')).run();expect(canReadSharedConversation(db,{kind:'member',id:'member-0'},cv.id)).toBe(false);
 expect(canReadSharedConversation(db,viewer,'missing')).toBe(false);
});
