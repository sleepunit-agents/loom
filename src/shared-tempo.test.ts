import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, agents, memberAgents, tokens, inbox, agentModels, agentRunSettings, jobs } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const cleanup: (()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const credential='tempo-owner-credential-'.repeat(3), hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function fixture(){
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:now()},{id:'sam',role:'member',joinedAt:now()}]).run();
 db.insert(agents).values({id:'art',about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(memberAgents).values({member:'owner',agent:'art'}).run();
 db.insert(agentModels).values({agent:'art',model:'model',position:0}).run();
 db.insert(agentRunSettings).values({agent:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
 db.insert(tokens).values({fingerprint:hash(credential),label:'Owner',kind:'owner',member:'owner',createdAt:now()}).run();
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError(error){throw error;}});
 cleanup.push(()=>client.close(),()=>root.close());
 const call=(name:string,input:unknown,id:string)=>root.http.request('http://loom/api/'+name.replace('.','/'),{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential},body:JSON.stringify({input,id})});
 const trigger={id:'delivery',ownerKind:'household',sourceKind:'time',times:now(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'Check pump',note:'Delivery'};
 return {client,db,clock,now,root,call,trigger};
}
it('real shared root fires once, settles then queues a job and withdraws command authority before replay',async()=>{
 const f=fixture();
 expect((await f.call('tempo.set',f.trigger,'set')).status).toBe(200);
 expect(f.db.select().from(inbox).all()).toMatchObject([{source:'trigger',words:'Check pump'}]);
 expect(f.db.select().from(jobs).all()).toEqual([]);
 f.clock.advance(4999);expect(f.db.select().from(jobs).all()).toEqual([]);
 f.clock.advance(1);expect(f.db.select().from(jobs).all()).toMatchObject([{agent:'art',state:'queued'}]);
 expect((await f.call('tempo.set',f.trigger,'set')).status).toBe(200);
 expect(f.db.select().from(inbox).all()).toHaveLength(1);
 f.root.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run());
 expect((await f.call('tempo.set',f.trigger,'set')).status).toBe(403);
});
it('holds paused triggers, resumes through shared commands, then stops timers before root closes',async()=>{
 const f=fixture();
 expect((await f.call('tempo.pause',{agent:'art'},'pause')).status).toBe(200);
 expect((await f.call('tempo.set',f.trigger,'set')).status).toBe(200);
 f.clock.advance(10000);expect(f.db.select().from(inbox).all()).toEqual([]);
 expect((await f.call('tempo.resume',{agent:'art'},'resume')).status).toBe(200);
 expect(f.db.select().from(inbox).all()).toHaveLength(1);
 await f.root.close();
 const before=f.db.select().from(jobs).all();f.clock.advance(10000);
 expect(f.db.select().from(jobs).all()).toEqual(before);
});
