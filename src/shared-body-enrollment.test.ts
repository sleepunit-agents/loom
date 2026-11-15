import Database from 'better-sqlite3';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,agents,boxes,jobs,tokens,sessions,operationResults,secrets,secretChanges,agentHouseSecrets,projects} from './core/data/schema.js';
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
 const changes:{type:string;id:string}[]=[];
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},changed:items=>{changes.push(...items);expect(client.inTransaction).toBe(false);},secretInputs:{source:{read:async()=>Buffer.from('PRIVATE_STARTUP')}}});clean.push(()=>root.close());
 const call=(input:unknown,credential=raw.runner,id=randomUUID(),cookie=false)=>root.http.request('http://loom/api/runtime/enrollBody',{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie:'loom_ui='+credential}:{authorization:'Bearer '+credential})},body:JSON.stringify({input,id})});
 const credential=()=> 'body_'+randomBytes(32).toString('hex');
 return {client,db,clock,now,root,call,credential,changes};
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
it('enrolls independent simultaneous and subsequent jobs without revoking another body',async()=>{
 const f=fixture(),first=f.credential(),second=f.credential(),third=f.credential();
 expect((await f.call({job:'job',fingerprint:hash(first)})).status).toBe(200);
 expect((await f.call({job:'other',fingerprint:hash(second)},raw.foreign)).status).toBe(200);
 expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+first}}))?.valid()).toBe(true);
 expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+second}}))?.valid()).toBe(true);
 f.root.writes.run(()=>{
  f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'job')).run();
  f.db.insert(jobs).values({id:'next-job',box:'worker',agent:'art',state:'starting',title:'',brief:'',model:'test',startedByKind:'agent',startedBy:'art',houseRepository:'',houseFile:'',houseBranch:'',queuedAt:f.now()}).run();
 });
 expect((await f.call({job:'next-job',fingerprint:hash(third)})).status).toBe(200);
 expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(first))).get()?.revokedAt).toBeNull();
 const bodies=f.db.select().from(tokens).all().filter(row=>row.job!==null);expect(new Set(bodies.map(row=>row.label)).size).toBe(3);
});
it('rejects other roles, foreign worker, cookie, forged labels and identity claims',async()=>{
 const f=fixture(),input={job:'job',fingerprint:hash(f.credential())};for(const token of [raw.owner,raw.agent,raw.foreign])expect((await f.call(input,token)).status).toBe(403);expect((await f.call(input,raw.cookie,randomUUID(),true)).status).toBe(403);
 for(const extra of [{agent:'art'},{box:'worker'},{token:f.credential()},{member:'owner'}])expect((await f.call({...input,...extra})).status).toBe(400);
 expect(await f.root.operations.callAsync('http',{kind:'runner',id:'worker'},'runtime.enrollBody',input,randomUUID())).toMatchObject({ok:false,code:'denied'});expect(f.root.credentials.runnerEnrollment({kind:'runner',id:'worker'})).toBeUndefined();expect((await f.call({job:'other',fingerprint:input.fingerprint})).status).toBe(403);
});
it.each(['queued','running','waiting','done','failed','stopped','lost'] as const)('refuses enrollment/replay after job state becomes %s',async state=>{
 const f=fixture(),input={job:'job',fingerprint:hash(f.credential())},id=randomUUID();expect((await f.call(input,raw.runner,id)).status).toBe(200);f.root.writes.run(()=>f.db.update(jobs).set({state}).where(eq(jobs.id,'job')).run());expect((await f.call(input,raw.runner,id)).status).toBe(403);expect((await f.call({job:'job',fingerprint:hash(f.credential())})).status).toBe(403);
});
it.each(['owner','agent','runner','other-job','expired','future','revoked'] as const)('never repurposes a %s fingerprint and leaves the current body usable',async kind=>{
 const f=fixture(),body=f.credential();await f.call({job:'job',fingerprint:hash(body)});const fingerprint=kind==='owner'?hash(raw.owner):kind==='agent'?hash(raw.agent):kind==='runner'?hash(raw.runner):hash(f.credential());
 if(!['owner','agent','runner'].includes(kind))f.db.insert(tokens).values({fingerprint,label:'Collision',kind:'agent',agent:'art',job:kind==='other-job'?'other':'job',createdAt:kind==='future'?new Date(f.clock.now()+1000).toISOString():f.now(),expiresAt:kind==='expired'?f.now():null,revokedAt:kind==='revoked'?f.now():null}).run();
 expect((await f.call({job:'job',fingerprint})).status).toBe(403);expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(body))).get()?.revokedAt).toBeNull();
});
it('rolls token rotation back with a refused receipt and publishes no partial registration',async()=>{
 const f=fixture(),body=f.credential();await f.call({job:'job',fingerprint:hash(body)});const next=hash(f.credential());expect(f.changes.some(change=>change.type==='token')).toBe(true);f.changes.length=0;f.client.exec("CREATE TRIGGER refuse_body_receipt BEFORE INSERT ON operation_results WHEN NEW.operation='runtime.enrollBody' BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await f.call({job:'job',fingerprint:next})).status).toBe(503);expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,next)).get()).toBeUndefined();expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(body))).get()?.revokedAt).toBeNull();expect(f.changes.filter(change=>change.type==='token')).toEqual([]);
});
it('rechecks captured worker proof after token rebinding, job reassignment, revocation and shutdown',async()=>{
 const f=fixture(),auth=f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+raw.runner}}))!;expect(f.root.credentials.runnerEnrollment(auth.viewer)).toMatchObject({box:'worker',fingerprint:hash(raw.runner)});
 f.root.writes.run(()=>f.db.update(tokens).set({box:'foreign'}).where(eq(tokens.fingerprint,hash(raw.runner))).run());expect(auth.valid()).toBe(false);expect(f.root.credentials.runnerEnrollment(auth.viewer)).toBeUndefined();expect((await f.call({job:'job',fingerprint:hash(f.credential())})).status).toBe(403);
 f.root.writes.run(()=>f.db.update(tokens).set({box:'worker'}).where(eq(tokens.fingerprint,hash(raw.runner))).run());f.root.writes.run(()=>f.db.update(jobs).set({box:'foreign'}).where(eq(jobs.id,'job')).run());expect((await f.call({job:'job',fingerprint:hash(f.credential())})).status).toBe(403);
 f.root.writes.run(()=>f.db.update(boxes).set({revokedAt:f.now()}).where(eq(boxes.id,'worker')).run());expect((await f.call({job:'job',fingerprint:hash(f.credential())})).status).toBe(401);await f.root.close();f.client.close();expect(f.root.credentials.runnerEnrollment(auth.viewer)).toBeUndefined();
});
it('rejects cookie-backed enrollment and cannot persist mixed runner claims',async()=>{
 const f=fixture(),cookie=f.root.credentials.authenticate(new Request('http://loom',{headers:{cookie:'loom_ui='+raw.cookie}}))!;expect(cookie.viewer).toEqual({kind:'runner',id:'worker'});expect(f.root.credentials.runnerEnrollment(cookie.viewer)).toBeUndefined();
 expect(()=>f.db.update(tokens).set({member:'owner'}).where(eq(tokens.fingerprint,hash(raw.runner))).run()).toThrow(/tokens_identity/);expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(raw.runner))).get()?.member).toBeNull();
});
it('conflicts old enrollment receipts after current worker credential or saved context changes',async()=>{
 const f=fixture(),input={job:'job',fingerprint:hash(f.credential())},id=randomUUID();expect((await f.call(input,raw.runner,id)).status).toBe(200);const replacement='z'.repeat(64);f.db.insert(tokens).values({fingerprint:hash(replacement),label:'Replacement worker',kind:'runner',box:'worker',createdAt:f.now()}).run();expect((await f.call(input,replacement,id)).status).toBe(409);
 f.db.update(jobs).set({member:'owner'}).where(eq(jobs.id,'job')).run();expect((await f.call(input,raw.runner,id)).status).toBe(409);expect(f.db.select().from(tokens).where(eq(tokens.job,'job')).all()).toHaveLength(1);
});
it('refuses malformed fingerprints without creating a credential or receipt',async()=>{
 const f=fixture();for(const fingerprint of [f.credential(),'a'.repeat(63),'A'.repeat(64)])expect((await f.call({job:'job',fingerprint})).status).toBe(400);expect(f.db.select().from(operationResults).all()).toEqual([]);expect(f.db.select().from(tokens).where(eq(tokens.job,'job')).all()).toEqual([]);
});
it('preserves the entire matching active credential across replay and fresh ids without extending finite expiry',async()=>{
 const f=fixture(),input={job:'job',fingerprint:hash(f.credential())},id=randomUUID();await f.call(input,raw.runner,id);f.db.update(tokens).set({expiresAt:new Date(f.clock.now()+600000).toISOString()}).where(eq(tokens.fingerprint,input.fingerprint)).run();const before=f.db.select().from(tokens).where(eq(tokens.fingerprint,input.fingerprint)).get();f.clock.advance(1000);expect((await f.call(input,raw.runner,id)).status).toBe(200);expect((await f.call(input)).status).toBe(200);expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,input.fingerprint)).get()).toEqual(before);
});
it.each([{member:'owner'},{box:'foreign'}])('schema refuses a mixed-subject body row without revoking the existing body: %j',async extra=>{
 const f=fixture(),body=f.credential();await f.call({job:'job',fingerprint:hash(body)});expect(()=>f.db.update(tokens).set(extra).where(eq(tokens.fingerprint,hash(body))).run()).toThrow(/tokens_identity/);expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(body))).get()?.revokedAt).toBeNull();expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+body}}))?.valid()).toBe(true);
});
it('retains existing job-body authority when only its issuing runner credential is revoked',async()=>{
 const f=fixture(),body=f.credential();await f.call({job:'job',fingerprint:hash(body)});const started=await f.root.http.request('http://loom/api/runtime/started',{method:'POST',headers:{authorization:'Bearer '+raw.runner,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{job:'job',build:'artifact'}})});expect(started.status).toBe(200);
 f.root.writes.run(()=>f.db.update(tokens).set({revokedAt:f.now()}).where(eq(tokens.fingerprint,hash(raw.runner))).run());expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+body}}))?.valid()).toBe(true);
 f.db.insert(secrets).values({name:'TOKEN',description:'',changedAt:f.now(),changedBy:'owner'}).run();f.db.insert(secretChanges).values({id:'baseline',secret:'TOKEN',action:'add',by:'owner',at:f.now()}).run();f.db.insert(agentHouseSecrets).values({agent:'art',alias:'API_TOKEN',secret:'TOKEN'}).run();f.root.writes.run(()=>f.root.services.secrets.requests.setRule({secret:'TOKEN',answer:'auto',minutes:5,agents:[{agent:'art',when:'at_start'}]}));
 const recipient=privateSecretClient({url:'https://loom.test',token:body,signal:new AbortController().signal,clock:f.clock,fetch:async(url,options)=>f.root.http.request(String(url),options)});try{const values=await recipient.startup();expect(values.get('API_TOKEN')?.toString()).toBe('PRIVATE_STARTUP');for(const bytes of values.values())bytes.fill(0);}finally{recipient.close();}
});

it('derives a different actual job agent instead of a caller or default agent',async()=>{
 const f=fixture(),body=f.credential();f.db.insert(agents).values({id:'mark',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();f.db.update(jobs).set({agent:'mark'}).where(eq(jobs.id,'job')).run();expect((await f.call({job:'job',fingerprint:hash(body)})).status).toBe(200);expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(body))).get()).toMatchObject({kind:'agent',agent:'mark',job:'job'});expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+body}}))?.viewer).toEqual({kind:'agent',id:'mark'});
});

it('rejects non-HTTP doors even for an actual authenticated worker proof',async()=>{
 const f=fixture(),auth=f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+raw.runner}}))!,input={job:'job',fingerprint:hash(f.credential())};expect(f.root.credentials.runnerEnrollment(auth.viewer)).toBeDefined();for(const door of ['mcp','direct'] as const)expect(await f.root.operations.callAsync(door,auth.viewer,'runtime.enrollBody',input,randomUUID())).toMatchObject({ok:false,code:'denied'});expect(f.db.select().from(tokens).where(eq(tokens.job,'job')).all()).toEqual([]);expect((await f.call(input)).status).toBe(200);
});
it.each(['conversation','project'] as const)('binds enrollment receipt to the current saved %s',async field=>{
 const f=fixture(),input={job:'job',fingerprint:hash(f.credential())},id=randomUUID();expect((await f.call(input,raw.runner,id)).status).toBe(200);
 if(field==='conversation'){const conversation=f.root.services.conversations.open({agent:'art',venue:'loom',place:'new',label:'New'});f.root.writes.run(()=>f.db.update(jobs).set({conversation:conversation.id}).where(eq(jobs.id,'job')).run());}else{f.db.insert(projects).values({id:'project',name:'Project'}).run();f.root.writes.run(()=>f.db.update(jobs).set({project:'project'}).where(eq(jobs.id,'job')).run());}
 expect((await f.call(input,raw.runner,id)).status).toBe(409);expect(f.db.select().from(tokens).where(eq(tokens.job,'job')).all()).toHaveLength(1);
});
it.each(['expired','future'] as const)('refuses a cached enrollment receipt after its body hash becomes %s',async state=>{
 const f=fixture(),input={job:'job',fingerprint:hash(f.credential())},id=randomUUID();expect((await f.call(input,raw.runner,id)).status).toBe(200);f.db.update(tokens).set(state==='expired'?{expiresAt:f.now()}:{createdAt:new Date(f.clock.now()+1000).toISOString()}).where(eq(tokens.fingerprint,input.fingerprint)).run();const before=f.db.select().from(tokens).where(eq(tokens.fingerprint,input.fingerprint)).get();expect((await f.call(input,raw.runner,id)).status).toBe(403);expect((await f.call(input)).status).toBe(403);expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,input.fingerprint)).get()).toEqual(before);
});
