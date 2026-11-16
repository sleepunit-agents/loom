import {eq} from 'drizzle-orm';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDataSchema } from '../../core/data/database.js';
import { agents, members, projects, memberAgents, projectMembers, conversationPeople } from '../../core/data/schema.js';
import { Conversations } from '../../core/conversations/index.js';
import type { Viewer } from '../../core/index.js';
import { sharedPeopleConversations } from './people-conversations.js';
const clients:Database.Database[]=[];
afterEach(()=>{for(const c of clients.splice(0))c.close();});
function fixture(){
 const client=new Database(':memory:');clients.push(client);
 const db=createDataSchema(client,()=> '2026-11-14T18:00:00Z');
 db.insert(agents).values({id:'fiction',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(members).values(['owner','alice','bob','peer'].map(id=>({id,role:id==='owner'?'owner' as const:'member' as const,joinedAt:'2026-11-14T18:00:00Z'}))).run();
 db.insert(projects).values({id:'team',name:'Team'}).run();
 db.insert(memberAgents).values({member:'alice',agent:'fiction'}).run();
 db.insert(projectMembers).values({project:'team',member:'peer'}).run();
 const service=new Conversations(db,()=> '2026-11-14T18:00:00Z');
 const add=(place:string,scope:{member?:string;project?:string}={},kind:'person'|'agent'='person')=>{
  const c=service.open({agent:'fiction',venue:'discord',place,label:place,...scope});
  db.insert(conversationPeople).values({conversation:c.id,whoKind:kind,who:'friend'}).run();return c.id;
 };
 const reader=sharedPeopleConversations(db,id=>`/conversation/${encodeURIComponent(id)}`);
 const titles=(viewer:Viewer)=>reader.list(viewer,'friend').rows.map(r=>r.title).sort();
 return {db,add,reader,titles};
}
it('reads only conversations with this person, with metadata and the supplied route',()=>{
 const {add,reader}=fixture();const id=add('Visible');add('Agent with same slug',{},'agent');
 expect(reader.list({kind:'member',id:'owner'},'friend')).toEqual({available:true,rows:[{id,title:'Visible',href:`/conversation/${encodeURIComponent(id)}`}]});
 expect(reader.list({kind:'member',id:'owner'},'absent')).toEqual({available:true,rows:[]});
});
it('keeps private member precedence and project or agent visibility independent of the card',()=>{
 const {add,titles}=fixture();add('Agent');add('Team',{project:'team'});add('Private',{member:'bob',project:'team'});
 expect(titles({kind:'member',id:'owner'})).toEqual(['Agent','Private','Team']);
 expect(titles({kind:'member',id:'alice'})).toEqual(['Agent','Team']);
 expect(titles({kind:'member',id:'peer'})).toEqual(['Team']);
 expect(titles({kind:'member',id:'bob'})).toEqual(['Private']);
 expect(titles({kind:'agent',id:'fiction'})).toEqual(['Agent','Team']);
 expect(titles({kind:'member',id:'stranger'})).toEqual([]);
 expect(titles({kind:'runner',id:'fiction'})).toEqual([]);
});
it('refreshes sharing after revocation and does not hide visible rows behind private ones',()=>{
 const {db,add,titles}=fixture();add('Visible');
 for(let i=0;i<45;i++)add(`Private ${i}`,{member:'bob'});
 expect(titles({kind:'member',id:'alice'})).toEqual(['Visible']);
 db.delete(memberAgents).where(eq(memberAgents.member,'alice')).run();
 expect(titles({kind:'member',id:'alice'})).toEqual([]);
});
it('reports database errors instead of claiming a successful empty result',()=>{
 const {db,reader}=fixture();db.$client.close();clients.pop();
 expect(()=>reader.list({kind:'member',id:'owner'},'friend')).toThrow();
});

it('keeps one generated metadata statement for two and ten visible conversation links',()=>{
 const {db,add,reader}=fixture();const prepared=vi.spyOn(db.$client,'prepare');
 try{for(let n=0;n<10;n++){add('Visible '+n);if(n===1||n===9){prepared.mockClear();expect(reader.list({kind:'member',id:'alice'},'friend').rows).toHaveLength(n+1);expect(prepared).toHaveBeenCalledTimes(1);}}}finally{prepared.mockRestore();}
});
