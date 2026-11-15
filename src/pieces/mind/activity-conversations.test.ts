import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { agents, members, projects, conversations, digestItems } from '../../core/data/schema.js';
import { Conversations } from '../../core/conversations/index.js';
import type { Sharing, Viewer } from '../../policy.js';
import { sharedActivityConversations } from './activity-conversations.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
const owner: Viewer = { kind: 'member', id: 'owner' }, teammate: Viewer = { kind: 'member', id: 'teammate' };
function fixture() {
 const client = new Database(':memory:'); clients.push(client);
 let now = '2026-11-14T18:00:00.000Z';
 const db = createDataSchema(client, () => now);
 db.insert(members).values([{ id:'owner',role:'owner',joinedAt:now },{ id:'teammate',role:'member',joinedAt:now }]).run();
 db.insert(agents).values({ id:'fiction',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot' }).run();
 db.insert(projects).values({ id:'pond',name:'Pond' }).run();
 const sharing: Sharing = { members:{ owner:{owner:true,agents:[]},teammate:{owner:false,agents:[]} },projects:{ pond:{members:['teammate'],agents:['fiction']} },services:{} };
 const service = new Conversations(db, () => now);
 const reader = sharedActivityConversations(db, { sharing:()=>sharing, conversationHref:id=>`/conversation/${id}` });
 const query = { agent:'fiction',from:Date.parse('2026-11-14T00:00:00Z'),until:Date.parse('2026-11-15T00:00:00Z'),limit:601 };
 return {db,service,reader,sharing,query,at:(value:string)=>{now=value;}};
}
it('reads committed shared digests, lists and turn metadata, replacing moved conversations in the same window', () => {
 const f=fixture(),cv=f.service.open({agent:'fiction',venue:'discord',place:'channel',label:'Fit the hose',project:'pond'});
 f.service.turn({conversation:cv.id,kind:'message',fromKind:'person',fromId:'teammate'});
 f.service.turn({conversation:cv.id,kind:'reply',fromKind:'agent',fromId:'fiction'});
 const dg=f.service.digest({conversation:cv.id,run:'run-1',summary:'Shipped t-42 and sleepunit-agents/loom#42',items:[{kind:'ask',text:'Which hose?'},{kind:'decision',text:'Use 25 mm'},{kind:'task',text:'t-42'},{kind:'project',text:'Pond: t-44 sleepunit-agents/loom#44'}],question:{to:'teammate',words:'Order it?',answers:'yes-no',link:'/inbox'}});
 expect(f.reader.list(teammate,f.query).rows).toMatchObject([{kind:'digest',key:dg.id,turns:3,replies:1,asked:['Which hose?'],decided:['Use 25 mm'],tasks:['t-42'],needs:'Order it?',conversation:{id:cv.id,project:'pond',people:['fiction','teammate']}}]);
 expect(f.reader.read(owner,'fiction','digest',dg.id)).not.toHaveProperty('needs');
 expect(f.reader.read(owner,'fiction','digest',dg.id)?.references).toContain('Pond: t-44 sleepunit-agents/loom#44');
 expect(f.reader.read(teammate,'fiction','digest',dg.id)).toMatchObject({links:[{href:`/conversation/${cv.id}`}]});
 expect(f.reader.read(owner,'another','digest',dg.id)).toBeUndefined();
 f.service.digest({conversation:cv.id,run:'run-1',summary:'Revised',items:[{kind:'decision',text:'Wait'}]});
 expect(f.reader.read(teammate,'fiction','digest',dg.id)).toMatchObject({summary:'Revised',decided:['Wait'],asked:[],tasks:[]});
 expect(f.db.select().from(digestItems).all()).toHaveLength(1);
});
it('uses the central current scope for all three reads and filters private rows before applying the limit', () => {
 const f=fixture(),shared=f.service.open({agent:'fiction',venue:'slack',place:'shared',label:'Shared',project:'pond'});
 const dg=f.service.digest({conversation:shared.id,run:'shared',summary:'Shared result'});
 f.at('2026-11-14T19:00:00.000Z');
 const hidden=f.service.open({agent:'fiction',venue:'loom',place:'private',label:'Private',member:'owner'});
 const privateDigest=f.service.digest({conversation:hidden.id,run:'private',summary:'Private result'});
 expect(f.reader.list(teammate,{...f.query,limit:1}).rows.map(r=>r.key)).toEqual([dg.id]);
 expect(f.reader.read(teammate,'fiction','digest',privateDigest.id)).toBeUndefined();
 expect(f.reader.conversation(teammate,'fiction',hidden.id)).toBeUndefined();
 expect(f.reader.list(owner,f.query).rows.map(r=>r.key)).toEqual([privateDigest.id,dg.id]);
 expect(f.reader.agents?.(teammate)).toEqual(['fiction']);
 f.sharing.projects.pond.members=[];
 expect(f.reader.list(teammate,f.query).rows).toEqual([]);
 expect(f.reader.read(teammate,'fiction','digest',dg.id)).toBeUndefined();
 expect(f.reader.conversation(teammate,'fiction',shared.id)).toBeUndefined();
 expect(f.reader.agents?.(teammate)).toEqual([]);
});
it('keeps moved conversations without a digest in the interval and reads more than one run', () => {
 const f=fixture(),cv=f.service.open({agent:'fiction',venue:'wake',place:'schedule',label:'Daily review'});
 const old=f.service.digest({conversation:cv.id,run:'old',summary:'Before this window'});
 f.at('2026-11-14T19:00:00.000Z');f.service.turn({conversation:cv.id,kind:'wake',fromKind:'schedule'});
 const q={...f.query,from:Date.parse('2026-11-14T18:30:00Z')};
 expect(f.reader.list(owner,q).rows).toMatchObject([{kind:'conversation',key:cv.id,turns:1,more:[{id:`d~fiction~${old.id}`}]}]);
 const dg=f.service.digest({conversation:cv.id,run:'new',summary:'After this window began'});
 expect(f.reader.list(owner,q).rows.map(r=>r.key)).toEqual([dg.id]);
 expect(f.reader.read(owner,'fiction','conversation',cv.id)).toMatchObject({kind:'conversation',key:cv.id});
 expect(f.reader.list(owner,{...q,until:q.from}).rows).toEqual([]);
 expect(f.reader.list(owner,{...q,limit:0}).rows).toEqual([]);
 f.db.update(conversations).set({member:'teammate'}).where(eq(conversations.id,cv.id)).run();
 expect(f.reader.conversation(owner,'fiction',cv.id)).toMatchObject({member:'teammate'});
});

it('schedules the earliest future digest or conversation timestamp at both skew boundaries',()=>{
 const f=fixture(),now=Date.parse('2026-11-14T18:00:00Z');
 expect(f.reader.nextDeadline?.(now)).toBeUndefined();
 f.at(new Date(now+61000).toISOString());
 const cv=f.service.open({agent:'fiction',venue:'loom',place:'fiction',label:'Future fiction'});
 f.service.digest({conversation:cv.id,run:'future',summary:'Future fictional digest'});
 f.db.update(conversations).set({lastAt:new Date(now+62000).toISOString()}).where(eq(conversations.id,cv.id)).run();
 expect(f.reader.nextDeadline?.(now)).toBe(now+1000);
 expect(f.reader.nextDeadline?.(now+1000)).toBe(now+1001);
 expect(f.reader.nextDeadline?.(now+1001)).toBe(now+2000);
 expect(f.reader.nextDeadline?.(now+2000)).toBe(now+2001);
 expect(f.reader.nextDeadline?.(now+2001)).toBeUndefined();
});
