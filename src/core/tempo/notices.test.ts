import Database from 'better-sqlite3';
import {graphql,GraphQLObjectType,GraphQLSchema} from 'graphql/index.js';
import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {createDataSchema} from '../data/database.js';
import {members,agents,inbox,projects,projectMembers} from '../data/schema.js';
import {DataLive} from '../data/live.js';
import {settledNotices} from './notices.js';
const closes:(()=>void)[]=[];afterEach(()=>closes.splice(0).reverse().forEach(close=>close()));
function fixture(){
 const client=new Database(':memory:'),db=createDataSchema(client),live=new DataLive(),notices=settledNotices(db,()=>live.changed()),at='2026-11-14T12:00:00Z';
 db.insert(members).values([{id:'sam',role:'member',joinedAt:at},{id:'other',role:'member',joinedAt:at},{id:'owner',role:'owner',joinedAt:at}]).run();
 db.insert(agents).values({id:'sam',about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(projects).values({id:'pond',name:'Pond'}).run();db.insert(projectMembers).values({member:'sam',project:'pond'}).run();
 const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:notices.fields})}),query='{ settledInboxNotice { id count needs fyi } }';
 const read=async(kind='member',id='sam')=>{const result=await graphql({schema,source:query,contextValue:{viewer:{kind,id}}});expect(result.errors).toBeUndefined();return result.data?.settledInboxNotice;};
 const item=(id:string,values:Partial<typeof inbox.$inferInsert>={})=>db.insert(inbox).values({id,toKind:'person',to:'sam',member:'sam',source:'notice',fromKind:'agent',words:'PRIVATE WORDS',state:'waiting',at,changedAt:at,...values}).run();
 closes.push(()=>client.close(),()=>live.close(),()=>notices.close());return {db,client,live,notices,schema,query,read,item};
}
it('emits a real live delta with only the settled recipient count and a new occurrence',async()=>{
 const f=fixture(),watch=f.live.watch({schema:f.schema,query:f.query,contextValue:{viewer:{kind:'member',id:'sam'}},valid:()=>true});
 expect((await watch.next()).value?.patches).toEqual([{path:[],value:{settledInboxNotice:null}}]);
 f.item('a',{answers:'words'});f.item('b');const pending=watch.next();expect(f.notices.publish('sam',['a','b'])).toBe(true);
 const notice=await pending;expect(notice.value?.patches).toMatchObject([{path:['settledInboxNotice'],value:{count:2,needs:1,fyi:1,id:expect.any(String)}}]);
 expect(JSON.stringify(notice)).not.toContain('PRIVATE WORDS');expect(JSON.stringify(notice)).not.toContain('"a"');
 const first=await f.read();f.notices.publish('sam',['a','b']);expect(await f.read()).not.toEqual(first);await watch.return?.();
});
it('never exposes another recipient notice to an owner, agent, runner or service',async()=>{
 const f=fixture();f.item('a');f.notices.publish('sam',['a']);
 for(const [kind,id] of [['member','other'],['member','owner'],['agent','sam'],['runner','sam'],['service','sam']])expect(await f.read(kind,id)).toBeNull();
 expect(await f.read()).toMatchObject({count:1});
});
it('filters mute, finished, other-recipient and hidden items before publishing, then rechecks current sharing',async()=>{
 const f=fixture();f.item('public',{member:null,project:'pond'});f.item('hidden',{member:'other'});f.item('mute',{volume:'mute',quietUntil:'2026-11-15T00:00:00Z'});f.item('done',{state:'done'});f.item('other',{to:'other',member:'other'});f.item('wrong-person',{to:'other',member:'sam'});f.item('wrong-kind',{toKind:'agent',to:'sam',member:'sam'});
 expect(f.notices.publish('sam',['hidden','mute','done','other','wrong-person','wrong-kind'])).toBe(false);expect(await f.read()).toBeNull();
 expect(f.notices.publish('sam',['public','hidden','mute','done','other','wrong-person','wrong-kind'])).toBe(true);expect(await f.read()).toMatchObject({count:1});
 f.db.delete(projectMembers).run();f.live.changed();expect(await f.read()).toBeNull();
 f.item('own');f.notices.publish('sam',['own']);expect(await f.read()).toMatchObject({count:1});
 f.db.update(inbox).set({to:'other'}).where(eq(inbox.id,'own')).run();expect(await f.read()).toBeNull();
 f.db.update(inbox).set({to:'sam'}).where(eq(inbox.id,'own')).run();expect(await f.read()).toMatchObject({count:1});
 f.db.update(inbox).set({toKind:'agent'}).where(eq(inbox.id,'own')).run();expect(await f.read()).toBeNull();
 f.db.update(inbox).set({toKind:'person'}).where(eq(inbox.id,'own')).run();expect(await f.read()).toMatchObject({count:1});
 f.db.update(inbox).set({volume:'mute',quietUntil:'2026-11-15T00:00:00Z'}).where(eq(inbox.id,'own')).run();expect(await f.read()).toBeNull();
 f.db.update(inbox).set({volume:'full',quietUntil:null}).where(eq(inbox.id,'own')).run();expect(await f.read()).toMatchObject({count:1});
 f.db.update(inbox).set({state:'done'}).where(eq(inbox.id,'own')).run();expect(await f.read()).toBeNull();
});
it('stops retained reads and late admission before touching a closed database',async()=>{
 const f=fixture();f.item('a');f.notices.publish('sam',['a']);f.notices.close();f.client.close();
 expect(f.notices.publish('sam',['a'])).toBe(false);expect(await f.read()).toBeNull();
});

it('refuses to publish provisional state from a transaction that can roll back',async()=>{
 const f=fixture();f.item('a');
 expect(()=>f.db.transaction(()=>{f.notices.publish('sam',['a']);})).toThrow('after commit');
 expect(await f.read()).toBeNull();
});
