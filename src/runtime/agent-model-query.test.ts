import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {getRequestListener} from '@hono/node-server';
import {WebSocket} from 'ws';
import {FakeClock} from '../core/clock.js';
import {createDataSchema} from '../core/data/database.js';
import {sharedRoot} from '../shared-root.js';
import type {ProgramGrants} from '../shared-program-access.js';
import {and,eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials} from '../../test/fixtures/conversation-body.js';
import {agentModelsSelection,runtimeAccountsQuery} from '../../web/src/pieces/runtime/model-query.js';
import * as s from '../core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const document=runtimeAccountsQuery;
async function fixture(){
 const f=await bodyFixture(clean);
 f.db.insert(s.memberAgents).values({member:'bob',agent:'mark'}).run();
 f.db.insert(s.agentModels).values([{agent:'art',model:'fallback',position:1},{agent:'art',model:'preferred',position:0},{agent:'mark',model:'mark-only',position:0}]).run();
 const read=async(token=bodyCredentials.member)=>{const response=await f.root.http.request('/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query:document})});const result=await response.json();expect(response.status).toBe(200);expect(result.errors).toBeUndefined();return result.data.agentModels;};
 return {...f,read};
}
it('exposes the ordered list with current agent visibility, including household owners',async()=>{
 const f=await fixture();
 expect(await f.read()).toEqual([{agent:'art',model:'preferred',position:0},{agent:'art',model:'fallback',position:1}]);
 const bob=f.root.writes.run(()=>f.root.services.signin.issue({kind:'owner',member:'bob',label:'Fictitious model reader'})).value;
 try{expect(await f.read(bob.token)).toEqual([{agent:'mark',model:'mark-only',position:0}]);}
 finally{f.root.writes.run(()=>f.root.services.signin.revoke(bob.fingerprint));}
 f.root.writes.run(()=>f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run());
 expect(await f.read()).toHaveLength(3);
});
it('withdraws preferences when the viewers project or agent access ends',async()=>{
 const f=await fixture();
 f.root.writes.run(()=>f.db.insert(s.projectAgents).values({project:'pond',agent:'mark'}).run());
 expect(await f.read()).toHaveLength(3);
 f.root.writes.run(()=>f.db.delete(s.projectMembers).where(and(eq(s.projectMembers.project,'pond'),eq(s.projectMembers.member,'alice'))).run());
 expect(await f.read()).toEqual([{agent:'art',model:'preferred',position:0},{agent:'art',model:'fallback',position:1}]);
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(and(eq(s.memberAgents.member,'alice'),eq(s.memberAgents.agent,'art'))).run());
 expect(await f.read()).toEqual([]);
});

it('gives an agent its current visible scope without exposing unrelated preferences',async()=>{
 const f=await fixture();
 expect(await f.read(bodyCredentials.agent)).toEqual([{agent:'art',model:'preferred',position:0},{agent:'art',model:'fallback',position:1}]);
 f.root.writes.run(()=>f.db.insert(s.projectAgents).values({project:'pond',agent:'mark'}).run());
 expect(await f.read(bodyCredentials.agent)).toHaveLength(3);
 f.root.writes.run(()=>f.db.delete(s.projectAgents).where(and(eq(s.projectAgents.project,'pond'),eq(s.projectAgents.agent,'art'))).run());
 expect(await f.read(bodyCredentials.agent)).toHaveLength(2);
});
it('uses the worker tie-break order in the actual UI selection',async()=>{
 const f=await fixture();
 f.root.writes.run(()=>f.db.insert(s.agentModels).values([{agent:'art',model:'a-order',position:0},{agent:'art',model:'Z-order',position:0}]).run());
 expect((await f.read()).map((row:{model:string})=>row.model)).toEqual(['Z-order','a-order','preferred','fallback']);
});

it('requires an explicit program record grant and keeps its current member scope',async()=>{
 const client=new Database(':memory:');clean.push(()=>{client.close();});
 const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(s.members).values([{id:'alice',role:'member',joinedAt:at},{id:'bob',role:'member',joinedAt:at}]).run();
 db.insert(s.agents).values(['art','mark'].map(id=>({id,about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
 db.insert(s.memberAgents).values([{member:'alice',agent:'art'},{member:'bob',agent:'mark'}]).run();
 db.insert(s.agentModels).values([{agent:'art',model:'visible-model',position:0},{agent:'mark',model:'private-model',position:0}]).run();
 const token='p'.repeat(64),fingerprint=createHash('sha256').update(token).digest('hex');
 db.insert(s.tokens).values({fingerprint,kind:'owner',member:'alice',label:'Fictitious program',createdAt:at}).run();
 const grants=new Map<string,ProgramGrants>([[fingerprint,{records:['agents'],operations:[]}]]);
 const root=sharedRoot({db,clock,originAllowed:()=>true,programGrants:fp=>grants.get(fp),reportError:()=>{}});clean.push(()=>root.close());
 const read=async()=>await(await root.http.request('/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query:'{'+agentModelsSelection+'}'})})).json();
 expect((await read()).errors).toBeDefined();
 grants.set(fingerprint,{records:['agentModels'],operations:[]});
 expect(await read()).toEqual({data:{agentModels:[{agent:'art',model:'visible-model',position:0}]}});
 grants.set(fingerprint,{records:[],operations:[]});
 const denied=await read();expect(denied.errors).toBeDefined();expect(JSON.stringify(denied)).not.toMatch(/visible-model|private-model/);
});
it('withdraws model rows from an already open live selection when project access ends',async()=>{
 const f=await fixture();f.root.writes.run(()=>f.db.insert(s.projectAgents).values({project:'pond',agent:'mark'}).run());
 const server=createServer(getRequestListener(request=>f.root.http.fetch(request))),detach=f.root.attach(server);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 clean.push(async()=>{detach();await new Promise<void>(r=>server.close(()=>r()));});
 const address=server.address();if(!address||typeof address==='string')throw Error('No fixture port');
 const ws=new WebSocket('ws://127.0.0.1:'+address.port+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+bodyCredentials.member}});clean.push(()=>ws.terminate());
 await once(ws,'open');let next=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await next;
 next=once(ws,'message');ws.send(JSON.stringify({type:'subscribe',id:'models',payload:{query:'subscription { observe(query:'+JSON.stringify('{ agentModels(where:{agent:{eq:"mark"}}){agent model position} }')+') { patches { path value removed } } }'}}));
 expect(String((await next)[0])).toContain('mark-only');
 next=once(ws,'message');f.root.writes.run(()=>f.db.delete(s.projectMembers).where(and(eq(s.projectMembers.project,'pond'),eq(s.projectMembers.member,'alice'))).run());
 const frame=String((await next)[0]);expect(JSON.parse(frame).payload.data.observe.patches).toContainEqual({path:['agentModels',0],value:null,removed:true});expect(frame).not.toContain('mark-only');
});
