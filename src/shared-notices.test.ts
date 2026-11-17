/** An agent's script raises something for the agent's owners, and clears it. */
import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash as hash} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
import {holds,tableRules,type Viewer} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
import {NOTICE_DETAIL_MAX,NOTICE_KEYS_MAX,NOTICE_PUSH_AGAIN_MS,NOTICE_TITLE_MAX} from './shared-notices.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const stop of clean.splice(0).reverse())await stop();});
async function fixture(){
 const sent:string[]=[];
 const f=await bodyFixture(clean,{notifications:{vapid:{publicKey:'fixture-public',privateKey:'fixture-private'},send:async subscription=>{sent.push(subscription.endpoint);}}});
 const at=()=>new Date(f.clock.now()).toISOString(),owner='o'.repeat(64),other='k'.repeat(64);
 // alice has art and a phone with push on. pat is a household owner who does not have art. mark has nobody.
 f.db.insert(s.members).values({id:'pat',role:'owner',joinedAt:at()}).run();
 f.db.insert(s.tokens).values([{fingerprint:hash(owner),label:'Fixture owner',kind:'owner',member:'pat',createdAt:at()},{fingerprint:hash(other),label:'Mark',kind:'agent',agent:'mark',createdAt:at()}]).run();
 f.db.insert(s.notificationDevices).values({endpoint:'https://fcm.googleapis.com/alice/phone',member:'alice',session:hash(raw.memberCookie),keys:JSON.stringify({p256dh:'p'.repeat(40),auth:'a'.repeat(16)}),device:'Phone',createdAt:at(),seenAt:at()}).run();
 const call=async(name:'raise'|'clear',input:unknown,token=raw.agent)=>{const response=await f.root.http.request('/api/notices/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input,id:randomUUID()})});return {status:response.status,body:await response.json() as {ok:boolean;code?:string;message?:string;value?:Record<string,unknown>}};};
 const notices=()=>f.db.select().from(s.inbox).where(eq(s.inbox.source,'notice')).all();
 const queued=()=>f.db.select().from(s.notificationQueue).all().length;
 return {...f,at,owner,other,call,notices,queued,sent};
}

it('raises one notice for each person who has the agent, private to them, and pushes to their devices',async()=>{
 const f=await fixture();
 const raised=await f.call('raise',{key:'disk:host-1',title:'Disk is 96% full on host-1',detail:'/var has 2 GB left'});
 expect(raised).toMatchObject({status:200,body:{ok:true,value:{item:'disk:host-1',raised:true,devices:1}}});
 // alice has art, so it is hers. pat is a household owner and does not have art: nothing for pat.
 expect(f.notices()).toMatchObject([{toKind:'person',to:'alice',member:'alice',source:'notice',fromKind:'agent',fromId:'art',words:'Disk is 96% full on host-1',why:'/var has 2 GB left',state:'waiting',volume:'full',conversation:null,project:null,answers:null}]);
 expect(f.queued()).toBe(1);
 // The push goes out once the write is committed, to that one device.
 await new Promise(resolve=>setTimeout(resolve,50));expect(f.sent).toEqual(['https://fcm.googleapis.com/alice/phone']);
 // Private to its recipient, like every notice loom makes: not read by another member, a household owner, or the agent.
 const item=f.notices()[0],reads=(viewer:Viewer)=>holds(tableRules.inbox,viewer,item,sharedSharing(f.db),()=>undefined);
 expect([reads({kind:'member',id:'alice'}),reads({kind:'member',id:'bob'}),reads({kind:'member',id:'pat'}),reads({kind:'agent',id:'art'})]).toEqual([true,false,false,false]);
 // The answer tells the agent its own key, whether it was new, and a count: nothing of anybody's Inbox.
 expect(Object.keys(raised.body.value!).sort()).toEqual(['devices','item','raised']);
 expect(JSON.stringify(raised.body)).not.toContain(item.id);
 // Raising it again while it waits adds none and pushes nothing; its words are brought up to date.
 const again=await f.call('raise',{key:'disk:host-1',title:'Disk is 98% full on host-1'});
 expect(again.body.value).toEqual({item:'disk:host-1',raised:false,devices:0});
 expect(f.notices()).toMatchObject([{id:item.id,words:'Disk is 98% full on host-1',why:null,state:'waiting'}]);
 expect(f.queued()).toBe(1);
 // Another key is another item. Quiet: filed dim, nothing pushed.
 expect((await f.call('raise',{key:'backup:nightly',title:'Backup ran late',quiet:true})).body.value).toEqual({item:'backup:nightly',raised:true,devices:0});
 expect(f.notices().map(row=>[row.words,row.volume])).toEqual([['Disk is 98% full on host-1','full'],['Backup ran late','dim']]);
 expect(f.queued()).toBe(1);
});

it('clears a notice with its reason, and does not push a key that is cleared and raised again at once',async()=>{
 const f=await fixture();
 await f.call('raise',{key:'disk:host-1',title:'Disk is full'});
 expect((await f.call('clear',{key:'disk:host-1',why:'Logs were rotated'})).body.value).toEqual({cleared:true});
 expect(f.notices()).toMatchObject([{state:'resolved',resolution:'Logs were rotated'}]);
 expect((await f.call('clear',{key:'disk:host-1',why:'Again'})).body.value).toEqual({cleared:false});
 expect((await f.call('clear',{key:'never:raised',why:'Nothing'})).body.value).toEqual({cleared:false});
 // Raised again straight away: a new waiting item, and no push.
 expect((await f.call('raise',{key:'disk:host-1',title:'Disk is full again'})).body.value).toEqual({item:'disk:host-1',raised:true,devices:0});
 expect(f.notices().map(row=>[row.state,row.volume])).toEqual([['resolved','full'],['waiting','dim']]);
 expect(f.queued()).toBe(1);
 // Once the time has passed, a fresh raise of that key pushes again.
 await f.call('clear',{key:'disk:host-1',why:'Rotated'});
 f.clock.advance(NOTICE_PUSH_AGAIN_MS+1000);
 expect((await f.call('raise',{key:'disk:host-1',title:'Disk is full, a third time'})).body.value).toEqual({item:'disk:host-1',raised:true,devices:1});
 expect(f.queued()).toBe(2);
 // Another agent's key of the same name is its own: clearing it touches nothing of art's.
 expect((await f.call('clear',{key:'disk:host-1',why:'Not mine'},f.other)).body.value).toEqual({cleared:false});
 expect(f.notices().filter(row=>row.state==='waiting')).toHaveLength(1);
});

it('takes a notice only from an agent’s own credential, for itself, within stated limits',async()=>{
 const f=await fixture(),good={key:'disk:host-1',title:'Disk is full'};
 // A member, a household owner and a worker raise nothing. A body is its agent while its member has the agent.
 for(const token of [raw.member,f.owner,raw.runner])for(const name of ['raise','clear'] as const)expect((await f.call(name,name==='raise'?good:{key:'k',why:'w'},token)).status,name).toBe(403);
 expect((await f.call('raise',good,raw.body)).body.value).toMatchObject({raised:true});
 f.root.writes.run(()=>f.db.delete(s.memberAgents).run());
 expect((await f.call('raise',{...good,key:'second'},raw.body)).status).toBe(403);
 // No input names an agent, a person or a tone: who it is from is the credential, and who it is for is who has the agent.
 for(const extra of [{agent:'mark'},{to:'pat'},{member:'pat'},{tone:'bad'}])expect((await f.call('raise',{...good,...extra})).status,JSON.stringify(extra)).toBe(400);
 for(const bad of [{...good,key:''},{...good,key:'has space'},{...good,key:'x'.repeat(121)},{...good,title:''},{...good,title:'x'.repeat(NOTICE_TITLE_MAX+1)},{...good,detail:'x'.repeat(NOTICE_DETAIL_MAX+1)}])
  expect((await f.call('raise',bad)).status,JSON.stringify(bad).slice(0,60)).toBe(400);
 expect((await f.call('clear',{key:'disk:host-1',why:''})).status).toBe(400);
 expect([NOTICE_TITLE_MAX,NOTICE_DETAIL_MAX,NOTICE_KEYS_MAX,NOTICE_PUSH_AGAIN_MS]).toEqual([200,2000,50,600000]);
});

it('goes to the household owners when nobody has the agent, and holds an agent to a number of waiting keys',async()=>{
 const f=await fixture();
 // mark is on nobody's list: its notice is the household owners'.
 expect((await f.call('raise',{key:'lost',title:'Mark cannot reach its house'},f.other)).body.value).toEqual({item:'lost',raised:true,devices:0});
 expect(f.notices()).toMatchObject([{to:'pat',member:'pat',fromId:'mark'}]);
 // Two people have art: one item each for the one raise, cleared together.
 f.root.writes.run(()=>f.db.insert(s.memberAgents).values({member:'bob',agent:'art'}).run());
 expect((await f.call('raise',{key:'both',title:'For both'})).body.value).toEqual({item:'both',raised:true,devices:1});
 expect(f.notices().filter(row=>row.fromId==='art').map(row=>[row.to,row.member]).sort()).toEqual([['alice','alice'],['bob','bob']]);
 expect((await f.call('clear',{key:'both',why:'Done'})).body.value).toEqual({cleared:true});
 expect(f.notices().filter(row=>row.fromId==='art'&&row.state==='waiting')).toEqual([]);
 // The limit is on keys waiting at once, for one agent.
 for(let n=0;n<NOTICE_KEYS_MAX;n++)expect((await f.call('raise',{key:'k'+n,title:'Notice '+n,quiet:true})).status,String(n)).toBe(200);
 const over=await f.call('raise',{key:'one-too-many',title:'No',quiet:true});
 expect(over).toMatchObject({status:409,body:{ok:false,message:'This agent already has '+NOTICE_KEYS_MAX+' notices waiting; clear one first'}});
 // A repeat of a waiting key, and another agent, are not held by it.
 expect((await f.call('raise',{key:'k0',title:'Notice 0 again',quiet:true})).body.value).toMatchObject({raised:false});
 expect((await f.call('raise',{key:'another',title:'Mark again'},f.other)).status).toBe(200);
});
