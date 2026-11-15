import Database from 'better-sqlite3';
import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,tokens} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import {sharedProgramSetup} from './shared-program-setup.js';
import type {ProgramGrants} from './shared-program-access.js';
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function fixture(){
 const client=new Database(':memory:');cleanup.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 for(const id of ['owner','sam'])db.insert(members).values({id,role:id==='owner'?'owner':'member',joinedAt:at}).run();
 // This is only the explicit persistence test port, not a production fallback.
 const values=new Map<string,ProgramGrants>(),write=vi.fn((id:string,value:ProgramGrants)=>{expect(client.inTransaction).toBe(true);values.set(id,value);}),store={read:(id:string)=>values.get(id),write};
 const service=sharedProgramSetup(db,clock,store,()=>({records:['tasks','projects'],operations:['tasks.command','household.setProject','token.revoke','account.read','program.grantsSet']}));
 const root=sharedRoot({db,clock,programGrants:store.read,originAllowed:()=>true,reportError:()=>{}});cleanup.push(()=>root.close());
 return{client,clock,db,at,values,write,store,service,root};
}
it('issues a real restricted bearer atomically, then keeps an empty marker restricted',async()=>{
 const f=fixture(),issued=f.service.issue({member:'sam',label:'Task tool',records:['tasks','tasks'],operations:[]});
 const fingerprint=createHash('sha256').update(issued.token).digest('hex');expect(issued.fingerprint).toBe(fingerprint);expect(f.values.get(fingerprint)).toEqual({records:['tasks'],operations:[]});
 const request=(query:string)=>f.root.http.request('http://loom/graphql',{method:'POST',headers:{authorization:'Bearer '+issued.token,'content-type':'application/json'},body:JSON.stringify({query})});
 expect(await(await request('{ tasks { id } }')).json()).toEqual({data:{tasks:[]}});
 expect((await(await request('{ projects { id } }')).json()).errors).toBeDefined();
 expect(f.service.set({fingerprint,records:[],operations:[]})).toEqual({saved:true});expect(f.values.has(fingerprint)).toBe(true);
 expect((await(await request('{ tasks { id } }')).json()).errors).toBeDefined();
 expect(JSON.stringify(f.db.select().from(tokens).all())).not.toContain(issued.token);
});
it.each([{records:['tokens'],operations:[]},{records:[],operations:['token.revoke']},{records:[],operations:['program.grantsSet']},{records:[],operations:['missing.operation']}])('refuses unsupported or credential-administration grants before minting: %j',grant=>{
 const f=fixture();expect(()=>f.service.issue({member:'sam',label:'Invalid tool',...grant})).toThrow();expect(f.db.select().from(tokens).all()).toEqual([]);expect(f.write).not.toHaveBeenCalled();
});
it('rolls back issuance rather than releasing an ordinary token when the marker writer does nothing',()=>{
 const f=fixture();f.write.mockImplementation(()=>{});
 expect(()=>f.service.issue({member:'sam',label:'Missing marker',records:['tasks'],operations:[]})).toThrow('Program grants were not persisted exactly');expect(f.db.select().from(tokens).all()).toEqual([]);
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
 expect(f.service.read()).toMatchObject([{fingerprint:issued.fingerprint,label:'Ended tool',member:'sam',ended:true,records:['tasks'],operations:['tasks.command']}]);
 expect(JSON.stringify(f.service.read())).not.toContain(issued.token);expect(()=>f.service.set({fingerprint:issued.fingerprint,records:[],operations:[]})).toThrow('Program token is not active');
});
it('never lets an owner-subject program grant itself wider credential authority',async()=>{
 const f=fixture(),issued=f.service.issue({member:'owner',label:'Owner tool',records:[],operations:[]});
 f.values.set(issued.fingerprint,{records:[],operations:['program.grantsSet']});const run=vi.fn(()=>({saved:true}));
 f.root.operations.register({name:'program.grantsSet',write:true,input:z.object({}).strict(),output:z.object({saved:z.literal(true)}),may:()=>true,run});
 const response=await f.root.http.request('http://loom/api/program/grantsSet',{method:'POST',headers:{authorization:'Bearer '+issued.token,'content-type':'application/json'},body:JSON.stringify({input:{},id:'self-escalation'})});
 expect(response.status).toBe(403);expect(run).not.toHaveBeenCalled();
 expect(f.service.catalogue().operations).toEqual(['household.setProject','tasks.command']);
});
