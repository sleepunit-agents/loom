import Database from 'better-sqlite3';
import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,tokens,agents,boxes} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import {sharedProgramSetup} from './shared-program-setup.js';
import type {ProgramGrants,ProgramGrantStore} from './shared-program-access.js';
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function fixture(){
 const client=new Database(':memory:');cleanup.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 for(const id of ['owner','sam'])db.insert(members).values({id,role:id==='owner'?'owner':'member',joinedAt:at}).run();
 // This is only the explicit persistence test port, not a production fallback.
 const values=new Map<string,ProgramGrants>(),write=vi.fn((id:string,value:ProgramGrants)=>{expect(client.inTransaction).toBe(true);values.set(id,value);return undefined;}),store={read:(id:string)=>values.get(id),write};
 let choices:ProgramGrants={records:['tasks','projects'],operations:['tasks.command','household.setProject','runtime.boxRevoke','token.revoke','account.read','signin.rotate','sessions.revoke','program.grantsSet']};
 const service=sharedProgramSetup(db,clock,store,()=>choices);
 const root=sharedRoot({db,clock,programGrants:store.read,originAllowed:()=>true,reportError:()=>{}});cleanup.push(()=>root.close());
 return{client,clock,db,at,values,write,store,service,root,choose:(value:ProgramGrants)=>{choices=value;}};
}
it('issues a real restricted bearer under a transaction, then keeps an empty marker restricted',async()=>{
 const f=fixture(),issued=f.service.issue({member:'sam',label:'Task tool',records:['tasks','tasks'],operations:[]});
 const fingerprint=createHash('sha256').update(issued.token).digest('hex');expect(issued.fingerprint).toBe(fingerprint);expect(f.values.get(fingerprint)).toEqual({records:['tasks'],operations:[]});
 const request=(query:string)=>f.root.http.request('http://loom/graphql',{method:'POST',headers:{authorization:'Bearer '+issued.token,'content-type':'application/json'},body:JSON.stringify({query})});
 expect(await(await request('{ tasks { id } }')).json()).toEqual({data:{tasks:[]}});
 expect((await(await request('{ projects { id } }')).json()).errors).toBeDefined();
 expect(f.service.set({fingerprint,records:[],operations:[]})).toEqual({saved:true});expect(f.values.has(fingerprint)).toBe(true);
 expect((await(await request('{ tasks { id } }')).json()).errors).toBeDefined();
 expect(JSON.stringify(f.db.select().from(tokens).all())).not.toContain(issued.token);
});
it.each([{records:['tokens'],operations:[]},{records:[],operations:['token.revoke']},{records:[],operations:['signin.rotate']},{records:[],operations:['sessions.revoke']},{records:[],operations:['program.grantsSet']},{records:[],operations:['missing.operation']}])('refuses unsupported records or reserved operations before minting: %j',grant=>{
 const f=fixture();expect(()=>f.service.issue({member:'sam',label:'Invalid tool',...grant})).toThrow();expect(f.db.select().from(tokens).all()).toEqual([]);expect(f.write).not.toHaveBeenCalled();
});
it('rolls back issuance rather than releasing an ordinary token when the marker writer does nothing',()=>{
 const f=fixture();f.write.mockImplementation(()=>{});
 expect(()=>f.service.issue({member:'sam',label:'Missing marker',records:['tasks'],operations:[]})).toThrow('Program permissions could not be saved');expect(f.db.select().from(tokens).all()).toEqual([]);
});
it('rolls back issuance if grant persistence throws and does not turn ordinary tokens into programs',()=>{
 const f=fixture();f.write.mockImplementation(()=>{throw Error('Fixture persistence failed');});
 expect(()=>f.service.issue({member:'sam',label:'Failed tool',records:[],operations:[]})).toThrow('Fixture persistence failed');expect(f.db.select().from(tokens).all()).toEqual([]);
 const ordinary=f.root.services.signin.issue({kind:'owner',member:'sam',label:'Ordinary'});
 expect(()=>f.service.set({fingerprint:ordinary.fingerprint,records:[],operations:[]})).toThrow('Program token not found');
 expect(f.values.has(ordinary.fingerprint)).toBe(false);
});
it('lists safe metadata including ended programs, and refuses to edit a revoked token',()=>{
 const f=fixture(),issued=f.service.issue({member:'sam',label:'Ended tool',records:['tasks'],operations:['tasks.command']});
 f.db.update(tokens).set({revokedAt:f.at}).where(eq(tokens.fingerprint,issued.fingerprint)).run();
 expect(f.service.list()).toMatchObject([{fingerprint:issued.fingerprint,label:'Ended tool',member:'sam',ended:true,records:['tasks'],operations:['tasks.command']}]);
 expect(JSON.stringify(f.service.list())).not.toContain(issued.token);expect(()=>f.service.set({fingerprint:issued.fingerprint,records:[],operations:[]})).toThrow('Program token is not active');
});
it('never lets an owner-subject program grant itself wider credential authority',async()=>{
 const f=fixture(),issued=f.service.issue({member:'owner',label:'Owner tool',records:[],operations:[]});
 f.values.set(issued.fingerprint,{records:[],operations:['program.grantsSet']});const run=vi.fn(()=>({saved:true}));
 f.root.operations.register({name:'program.grantsSet',write:true,input:z.object({}).strict(),output:z.object({saved:z.literal(true)}),may:()=>true,run});
 const response=await f.root.http.request('http://loom/api/program/grantsSet',{method:'POST',headers:{authorization:'Bearer '+issued.token,'content-type':'application/json'},body:JSON.stringify({input:{},id:'self-escalation'})});
 expect(response.status).toBe(403);expect(run).not.toHaveBeenCalled();
 expect(f.service.catalogue().operations).toEqual(['household.setProject','runtime.boxRevoke','tasks.command']);
});
it.each([{records:['projects','tasks'],operations:[]},{records:[],operations:[]}])('rolls back issuance if stored grants differ from the requested set: %j',stored=>{
 const f=fixture();f.write.mockImplementation((id)=>{f.values.set(id,stored);return undefined;});
 expect(()=>f.service.issue({member:'sam',label:'Wrong stored scope',records:['tasks'],operations:[]})).toThrow('Program permissions could not be saved');expect(f.db.select().from(tokens).all()).toEqual([]);
});
it('rejects editing an expired program and follows the current catalogue rather than a construction-time copy',()=>{
 const f=fixture(),issued=f.service.issue({member:'sam',label:'Expired tool',records:['tasks'],operations:[]});
 f.db.update(tokens).set({expiresAt:f.at}).where(eq(tokens.fingerprint,issued.fingerprint)).run();f.write.mockClear();
 expect(()=>f.service.set({fingerprint:issued.fingerprint,records:[],operations:[]})).toThrow('Program token is not active');expect(f.write).not.toHaveBeenCalled();
 expect(f.service.catalogue().records).toEqual(['projects','tasks']);f.choose({records:['projects'],operations:['household.setProject']});
 expect(f.service.catalogue()).toEqual({records:['projects'],operations:['household.setProject']});
 expect(()=>f.service.issue({member:'sam',label:'Old catalogue',records:['tasks'],operations:[]})).toThrow('Choose supported record types');
});
it.each(['agent','runner'] as const)('refuses a program marker attached to a valid %s credential',kind=>{
 const f=fixture();f.db.insert(agents).values({id:'art',about:'Fixture',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 f.db.insert(boxes).values({id:'box',name:'Box',owner:'owner',hostsAny:false,sameMachineAsLoom:false,reportOnly:true,alwaysOn:false,enrolledAt:f.at}).run();
 const issued=f.root.services.signin.issue(kind==='agent'?{kind,agent:'art',label:'Agent'}:{kind,box:'box',label:'Machine'});f.values.set(issued.fingerprint,{records:[],operations:[]});
 expect(()=>f.service.set({fingerprint:issued.fingerprint,records:[],operations:[]})).toThrow('Program token is not active');expect(f.write).not.toHaveBeenCalled();
});
it('has exact safe metadata fields and relies on canonical subject constraints',()=>{
 const f=fixture(),issued=f.service.issue({member:'sam',label:'Metadata',records:[],operations:[]});
 expect(Object.keys(f.service.list()[0]).sort()).toEqual(['fingerprint','label','member','createdAt','expiresAt','revokedAt','ended','records','operations'].sort());
 expect(()=>f.db.update(tokens).set({agent:'mixed-subject'}).where(eq(tokens.fingerprint,issued.fingerprint)).run()).toThrow(/tokens_identity/);
 expect(()=>f.db.delete(members).where(eq(members.id,'sam')).run()).toThrow(/FOREIGN KEY/);
});
it('allows explicitly granted ordinary lifecycle operations, not a retired legacy credential endpoint',async()=>{
 const f=fixture();expect(f.root.operations.has('runtime.revokeBox')).toBe(false);expect(f.root.operations.has('runtime.boxRevoke')).toBe(true);
 f.db.insert(boxes).values({id:'box',name:'Box',owner:'owner',hostsAny:false,sameMachineAsLoom:false,reportOnly:true,alwaysOn:false,enrolledAt:f.at}).run();
 const issued=f.service.issue({member:'owner',label:'Machine lifecycle',records:[],operations:['runtime.boxRevoke']});
 const response=await f.root.http.request('http://loom/api/runtime/boxRevoke',{method:'POST',headers:{authorization:'Bearer '+issued.token,'content-type':'application/json'},body:JSON.stringify({input:{box:'box'},id:'lifecycle'})});
 expect(response.status).toBe(200);expect(f.db.select().from(boxes).where(eq(boxes.id,'box')).get()?.revokedAt).toBe(f.at);
});
it('rejects an untyped asynchronous writer before invoking it or minting a token',()=>{
 const f=fixture();let called=false;
 const bad={read:f.store.read,write:async()=>{called=true;}} as unknown as ProgramGrantStore;
 expect(()=>sharedProgramSetup(f.db,f.clock,bad,()=>({records:[],operations:[]}))).toThrow('Program persistence must be synchronous SQLite');expect(called).toBe(false);expect(f.db.select().from(tokens).all()).toEqual([]);
});
it('rejects a promise returned by an untyped synchronous wrapper and rolls back the token',()=>{
 const f=fixture(),bad={read:f.store.read,write:()=>Promise.resolve()} as unknown as ProgramGrantStore;
 const service=sharedProgramSetup(f.db,f.clock,bad,()=>({records:[],operations:[]}));
 expect(()=>service.issue({member:'sam',label:'Async wrapper',records:[],operations:[]})).toThrow('Program permissions could not be saved');expect(f.db.select().from(tokens).all()).toEqual([]);
});
it('does not advertise a non-member credential as an owner-managed program',()=>{
 const f=fixture();f.db.insert(agents).values({id:'art',about:'Fixture',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();const issued=f.root.services.signin.issue({kind:'agent',agent:'art',label:'Agent marker'});f.values.set(issued.fingerprint,{records:[],operations:[]});expect(f.service.list()).toEqual([]);
});
it('does not interpret record names as reserved operation namespaces',()=>{
 const f=fixture();f.choose({records:['program','account'],operations:[]});
 const issued=f.service.issue({member:'sam',label:'Record-name port check',records:['program','account'],operations:[]});
 expect(f.service.catalogue().records).toEqual(['account','program']);expect(f.values.get(issued.fingerprint)).toEqual({records:['account','program'],operations:[]});
});
