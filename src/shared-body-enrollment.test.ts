import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,agents,boxes,jobs,tokens,sessions,operationResults,secrets,secretChanges,agentHouseSecrets} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import {privateSecretClient} from './pieces/secrets/private-client.js';
const clean:(()=>unknown|Promise<unknown>)[]=[];afterEach(async()=>{for(const stop of clean.splice(0).reverse())await stop();});
const raw={runner:'r'.repeat(64),foreign:'f'.repeat(64),owner:'o'.repeat(64),agent:'a'.repeat(64),cookie:'c'.repeat(64)};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture(){
 const client=new Database(':memory:');clean.push(()=>{if(client.open)client.close();});const db=createDataSchema(client),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString();
 db.insert(members).values({id:'owner',role:'owner',joinedAt:now()}).run();db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 for(const id of ['worker','foreign'])db.insert(boxes).values({id,name:id,owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
 for(const [id,box] of [['job','worker'],['other','foreign']])db.insert(jobs).values({id,box,agent:'art',state:'starting',title:'',brief:'',model:'test',startedByKind:'agent',startedBy:'art',houseRepository:'',houseFile:'',houseBranch:'',queuedAt:now()}).run();
 db.insert(tokens).values([{fingerprint:hash(raw.runner),label:'Worker',kind:'runner',box:'worker',createdAt:now()},{fingerprint:hash(raw.foreign),label:'Foreign',kind:'runner',box:'foreign',createdAt:now()},
  {fingerprint:hash(raw.owner),label:'Owner',kind:'owner',member:'owner',createdAt:now()},{fingerprint:hash(raw.agent),label:'Agent',kind:'agent',agent:'art',createdAt:now()}]).run();
 db.insert(sessions).values({id:hash(raw.cookie),token:hash(raw.runner),device:'Cookie',via:'token',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},secretInputs:{source:{read:async()=>Buffer.from('PRIVATE_STARTUP')}}});clean.push(()=>root.close());
 const call=(input:unknown,credential=raw.runner,id=randomUUID(),cookie=false)=>root.http.request('http://loom/api/runtime/enrollBody',{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie:'loom_ui='+credential}:{authorization:'Bearer '+credential})},body:JSON.stringify({input,id})});
 const credential=()=> 'body_'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
 return {client,db,clock,now,root,call,credential};
}
it('registers only the locally generated fingerprint and returns metadata, with a real body proof usable after started ACK',async()=>{
 const f=fixture(),body=f.credential(),fingerprint=hash(body),input={job:'job',fingerprint},id=randomUUID();
 const first=await f.call(input,raw.runner,id);expect(await first.json()).toEqual({ok:true,value:{registered:true}});expect((await f.call(input,raw.runner,id)).status).toBe(200);expect((await f.call(input)).status).toBe(200);
 expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,fingerprint)).get()).toMatchObject({kind:'agent',agent:'art',job:'job',member:null,box:null,madeFrom:hash(raw.runner),revokedAt:null});
 expect(f.root.credentials.body(f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+body}}))!.viewer)).toMatchObject({job:'job',agent:'art',box:'worker'});
 expect(f.client.serialize().includes(Buffer.from(body))).toBe(false);expect(f.db.select().from(operationResults).all().every(row=>!row.result.toString().includes(body))).toBe(true);
 const started=await f.root.http.request('http://loom/api/runtime/started',{method:'POST',headers:{authorization:'Bearer '+raw.runner,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{job:'job',build:'artifact'}})});expect(started.status).toBe(200);
 f.db.insert(secrets).values({name:'TOKEN',description:'',changedAt:f.now(),changedBy:'owner'}).run();f.db.insert(secretChanges).values({id:'baseline',secret:'TOKEN',action:'add',by:'owner',at:f.now()}).run();f.db.insert(agentHouseSecrets).values({agent:'art',alias:'API_TOKEN',secret:'TOKEN'}).run();f.root.writes.run(()=>f.root.services.secrets.requests.setRule({secret:'TOKEN',answer:'auto',minutes:5,agents:[{agent:'art',when:'at_start'}]}));
 const recipient=privateSecretClient({url:'https://loom.test',token:body,signal:new AbortController().signal,clock:f.clock,fetch:async(url,options)=>f.root.http.request(String(url),options)});try{const values=await recipient.startup();expect(values.get('API_TOKEN')?.toString()).toBe('PRIVATE_STARTUP');for(const bytes of values.values())bytes.fill(0);}finally{recipient.close();}
});
it('rotates prior job body tokens atomically and never revives a revoked fingerprint through a new id or old receipt',async()=>{
 const f=fixture(),first=f.credential(),second=f.credential(),id=randomUUID();expect((await f.call({job:'job',fingerprint:hash(first)},raw.runner,id)).status).toBe(200);const proof=f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+first}}))!;
 expect((await f.call({job:'job',fingerprint:hash(second)})).status).toBe(200);expect(proof.valid()).toBe(false);expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+first}}))).toBeUndefined();
 expect((await f.call({job:'job',fingerprint:hash(first)},raw.runner,id)).status).toBe(403);expect((await f.call({job:'job',fingerprint:hash(first)})).status).toBe(403);expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(second))).get()?.revokedAt).toBeNull();
});
it('rejects other roles, foreign worker, cookie, forged labels and identity claims',async()=>{
 const f=fixture(),input={job:'job',fingerprint:hash(f.credential())};for(const token of [raw.owner,raw.agent,raw.foreign])expect((await f.call(input,token)).status).toBe(403);expect((await f.call(input,raw.cookie,randomUUID(),true)).status).toBe(403);
 for(const extra of [{agent:'art'},{box:'worker'},{token:f.credential()},{member:'owner'}])expect((await f.call({...input,...extra})).status).toBe(400);
 expect(await f.root.operations.callAsync('http',{kind:'runner',id:'worker'},'runtime.enrollBody',input,randomUUID())).toMatchObject({ok:false,code:'denied'});expect(f.root.credentials.runnerEnrollment({kind:'runner',id:'worker'})).toBeUndefined();expect((await f.call({job:'other',fingerprint:input.fingerprint})).status).toBe(403);
});
it.each(['queued','running','waiting','done','failed','stopped','lost'] as const)('refuses enrollment/replay after job state becomes %s',async state=>{
 const f=fixture(),input={job:'job',fingerprint:hash(f.credential())},id=randomUUID();expect((await f.call(input,raw.runner,id)).status).toBe(200);f.root.writes.run(()=>f.db.update(jobs).set({state}).where(eq(jobs.id,'job')).run());expect((await f.call(input,raw.runner,id)).status).toBe(403);expect((await f.call({job:'job',fingerprint:hash(f.credential())})).status).toBe(403);
});
it.each(['owner','agent','other-job','expired','future','revoked'] as const)('never repurposes a %s fingerprint and leaves the current body usable',async kind=>{
 const f=fixture(),body=f.credential();await f.call({job:'job',fingerprint:hash(body)});const fingerprint=kind==='owner'?hash(raw.owner):kind==='agent'?hash(raw.agent):hash(f.credential());
 if(!['owner','agent'].includes(kind))f.db.insert(tokens).values({fingerprint,label:'Collision',kind:'agent',agent:'art',job:kind==='other-job'?'other':'job',createdAt:kind==='future'?new Date(f.clock.now()+1000).toISOString():f.now(),expiresAt:kind==='expired'?f.now():null,revokedAt:kind==='revoked'?f.now():null}).run();
 expect((await f.call({job:'job',fingerprint})).status).toBe(403);expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(body))).get()?.revokedAt).toBeNull();
});
it('rolls token rotation back with a refused receipt and publishes no partial registration',async()=>{
 const f=fixture(),body=f.credential();await f.call({job:'job',fingerprint:hash(body)});const next=hash(f.credential());f.client.exec("CREATE TRIGGER refuse_body_receipt BEFORE INSERT ON operation_results WHEN NEW.operation='runtime.enrollBody' BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await f.call({job:'job',fingerprint:next})).status).toBe(503);expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,next)).get()).toBeUndefined();expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(body))).get()?.revokedAt).toBeNull();
});
it('rechecks captured worker proof after token rebinding, job reassignment, revocation and shutdown',async()=>{
 const f=fixture(),auth=f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+raw.runner}}))!;expect(f.root.credentials.runnerEnrollment(auth.viewer)).toMatchObject({box:'worker',fingerprint:hash(raw.runner)});
 f.root.writes.run(()=>f.db.update(tokens).set({box:'foreign'}).where(eq(tokens.fingerprint,hash(raw.runner))).run());expect(auth.valid()).toBe(false);expect(f.root.credentials.runnerEnrollment(auth.viewer)).toBeUndefined();expect((await f.call({job:'job',fingerprint:hash(f.credential())})).status).toBe(403);
 f.root.writes.run(()=>f.db.update(tokens).set({box:'worker'}).where(eq(tokens.fingerprint,hash(raw.runner))).run());f.root.writes.run(()=>f.db.update(jobs).set({box:'foreign'}).where(eq(jobs.id,'job')).run());expect((await f.call({job:'job',fingerprint:hash(f.credential())})).status).toBe(403);
 f.root.writes.run(()=>f.db.update(boxes).set({revokedAt:f.now()}).where(eq(boxes.id,'worker')).run());expect((await f.call({job:'job',fingerprint:hash(f.credential())})).status).toBe(401);await f.root.close();f.client.close();expect(f.root.credentials.runnerEnrollment(auth.viewer)).toBeUndefined();
});
