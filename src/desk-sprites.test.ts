import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {agents,agentSprites,members,memberAgents,tokens} from './core/data/schema.js';
import {serveShared} from './shared-serve.js';
import {storeDeskSprite} from './desk-sprites.js';
import {checkSpriteLayout} from './desk-sprite-layout.js';
import {deskSpriteQuery} from '../web/src/pixel-face';
import {deskAgentDisplaysQuery} from '../web/src/pieces/attention/agent-displays';
import {sheet,REST_ROW} from './ui/pixel-sheet.fixture.js';
const cleanups:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const sample=sheet(['south']),manifest={cell:[56,84],states:{idle:{south:[{row:REST_ROW(['south']),frames:17,weight:1}]}}};
const raw={member:'m'.repeat(64),owner:'o'.repeat(64)},hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const client=new Database(':memory:');cleanups.push(()=>client.close());const clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 db.insert(members).values([{id:'member',role:'member',joinedAt:now()},{id:'owner',role:'owner',joinedAt:now()}]).run();
 db.insert(agents).values(['art','mark'].map(id=>({id,about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();db.insert(memberAgents).values({member:'member',agent:'art'}).run();
 db.insert(tokens).values(Object.entries(raw).map(([member,value])=>({fingerprint:hash(value),label:member,kind:'owner' as const,member,createdAt:now()}))).run();
 const art=storeDeskSprite(db,'art',manifest,{'sheet.png':sample.png}),mark=storeDeskSprite(db,'mark',manifest,{'sheet.png':sample.png});
 const app=await serveShared({db,clock,originAllowed:()=>true,reportError:error=>{throw error;}});cleanups.push(()=>app.close());
 const read=async(agent:string,version:string,member:keyof typeof raw='member')=>(await fetch(app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw[member]},body:JSON.stringify({query:deskSpriteQuery,variables:{agent,version}})})).json();
 return {db,app,art,mark,read};
}
it('selects actual versioned layout/sheet bytes under the existing current agent visibility and clears withdrawal',async()=>{
 const f=await fixture(),own=await f.read('art',f.art);expect(own.errors).toBeUndefined();expect(own.data.deskSprite.version).toBe(f.art);
 expect(JSON.parse(own.data.deskSprite.layout)).toEqual(checkSpriteLayout(manifest));expect(Buffer.from(JSON.parse(own.data.deskSprite.sheets)['sheet.png'],'base64').equals(sample.png)).toBe(true);
 expect(await f.read('mark',f.mark)).toEqual({data:{deskSprite:null}});expect((await f.read('mark',f.mark,'owner')).data.deskSprite.version).toBe(f.mark);expect(await f.read('art','stale')).toEqual({data:{deskSprite:null}});
 f.app.writes.run(()=>f.db.delete(memberAgents).run());expect(await f.read('art',f.art)).toEqual({data:{deskSprite:null}});expect(f.db.select().from(agentSprites).all()).toHaveLength(2);
});
it('keeps version and bytes atomic, rejects malformed input without effects and refuses inconsistent direct writes',async()=>{
 const f=await fixture();
 for(const images of [{},{'sheet.png':Buffer.from('bad')},{'../sheet.png':sample.png}])expect(()=>storeDeskSprite(f.db,'art',manifest,images)).toThrow();
 expect(f.db.select().from(agents).where(eq(agents.id,'art')).get()?.spriteVersion).toBe(f.art);
 const version=f.app.writes.run(()=>storeDeskSprite(f.db,'art',{...manifest,scale:.85},{'sheet.png':sample.png})).value;expect(version).not.toBe(f.art);expect(await f.read('art',f.art)).toEqual({data:{deskSprite:null}});expect((await f.read('art',version)).data.deskSprite.version).toBe(version);
 f.app.writes.run(()=>f.db.update(agentSprites).set({layout:'{}'}).where(eq(agentSprites.agent,'art')).run());expect(await f.read('art',version)).toEqual({data:{deskSprite:null}});
});
it('sends asset invalidation over the existing root socket and exposes the new metadata version in the generated selection',async()=>{
 const f=await fixture(),ws=new WebSocket(f.app.url.replace(/^http/,'ws')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+raw.member}});cleanups.push(()=>ws.terminate());await once(ws,'open');let message=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await message;
 message=once(ws,'message');ws.send(JSON.stringify({type:'subscribe',id:'sprite',payload:{query:'subscription($query:String!,$variables:DataValue){observe(query:$query,variables:$variables){patches{path value removed}}}',variables:{query:deskSpriteQuery,variables:{agent:'art',version:f.art}}}}));
 const first=JSON.parse(String((await message)[0]));expect(first.payload.data.observe.patches[0].value.deskSprite.version).toBe(f.art);
 message=once(ws,'message');const version=f.app.writes.run(()=>storeDeskSprite(f.db,'art',{...manifest,scale:.85},{'sheet.png':sample.png})).value;
 const changed=JSON.parse(String((await message)[0]));expect(changed.payload.data.observe.patches).toContainEqual({path:['deskSprite'],value:null,removed:false});
 const metadata=await fetch(f.app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.member},body:JSON.stringify({query:deskAgentDisplaysQuery})});expect((await metadata.json()).data.agents[0].spriteVersion).toBe(version);
});
