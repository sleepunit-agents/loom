import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from '../../core/data/database.js';
import { agents, members, projects, conversationPeople } from '../../core/data/schema.js';
import { Conversations } from '../../core/conversations/index.js';
import type { Sharing, Viewer } from '../../core/index.js';
import { sharedPeopleConversations } from './people-conversations.js';
const clients:Database.Database[]=[];
afterEach(()=>{for(const c of clients.splice(0))c.close();});
function fixture(){
 const client=new Database(':memory:');clients.push(client);
 const db=createDataSchema(client,()=> '2026-11-14T18:00:00Z');
 db.insert(agents).values({id:'fiction',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(members).values(['owner','alice','bob','peer'].map(id=>({id,role:id==='owner'?'owner' as const:'member' as const,joinedAt:'2026-11-14T18:00:00Z'}))).run();
 db.insert(projects).values({id:'team',name:'Team'}).run();
 let sharing:Sharing={members:{owner:{owner:true,agents:[]},alice:{owner:false,agents:['fiction']},bob:{owner:false,agents:[]},peer:{owner:false,agents:[]}},projects:{team:{members:['peer'],agents:[]}},services:{}};
 const service=new Conversations(db,()=> '2026-11-14T18:00:00Z');
 const add=(place:string,scope:{member?:string;project?:string}={},kind:'person'|'agent'='person')=>{
  const c=service.open({agent:'fiction',venue:'discord',place,label:place,...scope});
  db.insert(conversationPeople).values({conversation:c.id,whoKind:kind,who:'friend'}).run();return c.id;
 };
 const reader=sharedPeopleConversations(db,()=>sharing,id=>`/conversation/${encodeURIComponent(id)}`);
 const titles=(viewer:Viewer)=>reader.list(viewer,'friend').rows.map(r=>r.title).sort();
 return {db,sharing,add,reader,titles,replaceSharing:(next:Sharing)=>{sharing=next;}};
}
it('reads only conversations with this person, with metadata and the supplied route',()=>{
 const {add,reader}=fixture();const id=add('Visible');add('Agent with same slug',{},'agent');
 expect(reader.list({kind:'member',id:'owner'},'friend')).toEqual({available:true,rows:[{id,title:'Visible',href:`/conversation/${encodeURIComponent(id)}`}]});
 expect(reader.list({kind:'member',id:'owner'},'absent')).toEqual({available:true,rows:[]});
});
it('keeps private member precedence and project or agent visibility independent of the card',()=>{
 const {add,titles}=fixture();add('Agent');add('Team',{project:'team'});add('Private',{member:'bob',project:'team'});
 // The owner role reads the household's conversations, not another member's private one.
 expect(titles({kind:'member',id:'owner'})).toEqual(['Agent','Team']);
 expect(titles({kind:'member',id:'alice'})).toEqual(['Agent','Team']);
 expect(titles({kind:'member',id:'peer'})).toEqual(['Team']);
 expect(titles({kind:'member',id:'bob'})).toEqual(['Private']);
 expect(titles({kind:'agent',id:'fiction'})).toEqual(['Agent','Team']);
 expect(titles({kind:'member',id:'stranger'})).toEqual([]);
 expect(titles({kind:'runner',id:'fiction'})).toEqual([]);
});
it('refreshes sharing after revocation and does not hide visible rows behind private ones',()=>{
 const {add,sharing,titles,replaceSharing}=fixture();add('Visible');
 for(let i=0;i<45;i++)add(`Private ${i}`,{member:'bob'});
 expect(titles({kind:'member',id:'alice'})).toEqual(['Visible']);
 replaceSharing({...sharing,members:{...sharing.members,alice:{owner:false,agents:[]}}});
 expect(titles({kind:'member',id:'alice'})).toEqual([]);
});
it('reports database errors instead of claiming a successful empty result',()=>{
 const {db,reader}=fixture();db.$client.close();clients.pop();
 expect(()=>reader.list({kind:'member',id:'owner'},'friend')).toThrow();
});
