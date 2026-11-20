import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { GraphQLSchema, graphql } from 'graphql/index.js';
import { eq } from 'drizzle-orm';
import { createDataSchema } from './database.js';
import { dataQueries } from './queries.js';
import { conversationTables, conversationVisibility } from './conversation-visibility.js';
import { Conversations } from '../conversations/index.js';
import { ConversationHistory } from '../conversations/history.js';
import * as s from './schema.js';
import { nextData } from '../../next-data.js';
import { FakeClock } from '../clock.js';
const clients: Database.Database[]=[],close: (()=>Promise<void>)[]=[];afterEach(async()=>{for(const stop of close.splice(0))await stop();for(const c of clients.splice(0))c.close();});
it('filters every generated history root and nested child by current ordered conversation scope',async()=>{
 const c=new Database(':memory:');clients.push(c);let now='2026-07-01T00:00:00Z';const db=createDataSchema(c,()=>now);
 for(const id of ['alice','bob','owner'])db.insert(s.members).values({id,role:id==='owner'?'owner':'member',joinedAt:now}).run();
 db.insert(s.agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(s.memberAgents).values({member:'bob',agent:'art'}).run();
 const service=new Conversations(db,()=>now);
 for(const [place,member] of [['private','alice'],['ordinary',null]] as const){
  const cv=service.open({agent:'art',venue:'wake',place,label:place,member});
  service.turn({conversation:cv.id,kind:'reply',fromKind:'agent',fromId:'art',model:'actual',outcome:'answered'});
  service.digest({conversation:cv.id,run:'run',summary:place,items:[{kind:'decision',text:place}]});
  db.insert(s.findings).values({conversation:cv.id,day:'2026-07-01',turnSeq:1,measure:'useful',score:4,text:place}).run();
 }
 const schema=(id:string)=>dataQueries(c,{tables:[...conversationTables],visibility:conversationVisibility({kind:'member',id})});
 const retained=schema('owner'), retainedBob=schema('bob');
 let viewer='owner';const data=nextData(db,new FakeClock(Date.parse(now)),()=>true,undefined,{},()=>true,()=>({viewer:{kind:'member',id:viewer},valid:()=>true}));close.push(()=>data.close());
 const http=async(query:string)=>{const r=await data.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});expect(r.status).toBe(200);const result=await r.json() as {data:Record<string,unknown>;errors?:unknown[]};expect(result.errors).toBeUndefined();return result.data;};
 const read=(schema:GraphQLSchema,query:string)=>graphql({schema,source:query});
 const roots='{conversations{label conversationPeopleByConversation{who} turnsByConversation{seq} digestsByConversation{summary digestItemsByDigest{text}} findingsByConversation{text}} conversationPeople{who} turns{seq} digests{summary} digestItems{text} findings{text conversationRow{label}}}';
 const owner=await read(retained,roots);expect(owner.errors).toBeUndefined();
 // A household owner reads the household's conversations, never another member's private one; its member does.
 expect(JSON.stringify(owner.data)).not.toContain('private');expect(JSON.stringify(owner.data)).toContain('ordinary');expect(JSON.stringify((await read(schema('alice'),roots)).data)).toContain('private');

 expect(await http(roots)).toEqual(owner.data);viewer='bob';
 const bob=await read(retainedBob,roots);expect(bob.errors).toBeUndefined();expect(JSON.stringify(bob.data)).not.toContain('private');expect(bob.data?.turns).toHaveLength(1);expect(bob.data?.conversationPeople).toHaveLength(1);expect(bob.data?.digestItems).toEqual([{text:'ordinary'}]);expect(bob.data?.findings).toEqual([{text:'ordinary',conversationRow:{label:'ordinary'}}]);expect(await http(roots)).toEqual(bob.data);
 db.update(s.members).set({role:'member'}).where(eq(s.members.id,'owner')).run();expect((await read(retained,roots)).data).toEqual({conversations:[],conversationPeople:[],turns:[],digests:[],digestItems:[],findings:[]});
 now='2026-11-14T00:00:00Z';new ConversationHistory(db,()=>now).rollup();
 const dayQuery='{conversations{label conversationDaysByConversation{day}} conversationDays{day conversationRow{label}} turns{seq}}';
 const days=await read(retainedBob,dayQuery);expect(days.errors).toBeUndefined();expect(days.data?.conversationDays).toHaveLength(1);expect(days.data?.turns).toEqual([]);expect(days.data?.conversations).toEqual([{label:'ordinary',conversationDaysByConversation:[{day:'2026-07-01'}]}]);expect(await http(dayQuery)).toEqual(days.data);
 db.delete(s.memberAgents).run();expect((await read(retainedBob,'{conversationDays{day} conversations{id}}')).data).toEqual({conversationDays:[],conversations:[]});expect(await http(roots)).toEqual({conversations:[],conversationPeople:[],turns:[],digests:[],digestItems:[],findings:[]});
});
it('keeps project and private branches current for members and agents, excluding raw-word and credential surfaces in production',async()=>{
 const c=new Database(':memory:');clients.push(c);const now='2026-11-14T00:00:00Z',db=createDataSchema(c,()=>now);
 for(const id of ['alice','bob'])db.insert(s.members).values({id,role:'member',joinedAt:now}).run();
 for(const id of ['art','mark'])db.insert(s.agents).values({id,about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(s.projects).values({id:'pond',name:'Pond'}).run();db.insert(s.projectMembers).values({project:'pond',member:'bob'}).run();db.insert(s.projectAgents).values({project:'pond',agent:'mark'}).run();
 const cvs=new Conversations(db,()=>now);
 for(const member of [null,'alice']){const cv=cvs.open({agent:'art',project:'pond',member,venue:'discord',place:member??'public',label:member??'project'});cvs.turn({conversation:cv.id,kind:'reply',fromKind:'agent',fromId:'art'});}
 const viewers=[{kind:'member' as const,id:'bob'},{kind:'member' as const,id:'alice'},{kind:'agent' as const,id:'mark'},{kind:'agent' as const,id:'art'}];
 const schemas=viewers.map(viewer=>dataQueries(c,{tables:[...conversationTables],visibility:conversationVisibility(viewer)}));
 const query='{conversations{label turnsByConversation{seq}} turns{seq conversationRow{label}}}';
 for(const [i,expected] of ['project','alice','project','project'].entries()){
  const result=await graphql({schema:schemas[i],source:query});expect(result.errors).toBeUndefined();expect(result.data?.conversations).toEqual([{label:expected,turnsByConversation:[{seq:1}]}]);expect(result.data?.turns).toEqual([{seq:1,conversationRow:{label:expected}}]);
 }
 db.delete(s.projectMembers).run();db.delete(s.projectAgents).run();
 for(const i of [0,2])expect((await graphql({schema:schemas[i],source:query})).data).toEqual({conversations:[],turns:[]});
 const data=nextData(db,new FakeClock(Date.parse(now)),()=>true,undefined,{},()=>true,()=>({viewer:viewers[1],valid:()=>true}));close.push(()=>data.close());
 for(const forbidden of ['{messages{words}}','{threads{id}}','{tokens{fingerprint}}','{sessions{id}}','{operationResults{result}}','{inbox{words}}','{jobs{brief logTail}}','{conversations{threadsByConversation{messagesByThread{words}}}}','{conversations{jobRow{brief}}}','{agents{tokensByAgent{fingerprint}}}','{turns{words}}']){
  const response=await data.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:forbidden})});const result=await response.json() as {data?:unknown;errors?:unknown[]};expect(result.data).toBeUndefined();expect(result.errors?.length).toBeGreaterThan(0);
 }
});
