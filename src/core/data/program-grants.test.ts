import Database from 'better-sqlite3';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {eq} from 'drizzle-orm';
import {createDataSchema,dataDatabase} from './database.js';
import {members,tokens,programTokens,programRecordGrants,programOperationGrants} from './schema.js';
import {programGrantStore} from './program-grants.js';
import {sharedProgramSetup} from '../../shared-program-setup.js';
import {FakeClock} from '../clock.js';
const clean:Array<()=>void>=[];afterEach(()=>{for(const close of clean.splice(0).reverse())close();vi.restoreAllMocks();});
function fixture(file=':memory:',beforeStore?:(client:Database.Database)=>void){
 const client=new Database(file);clean.push(()=>{if(client.open)client.close();});const clock=new FakeClock(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(members).values({id:'sam',role:'member',joinedAt:new Date(clock.now()).toISOString()}).run();const fingerprint='f'.repeat(64);db.insert(tokens).values({fingerprint,kind:'owner',member:'sam',label:'Ordinary',createdAt:new Date(clock.now()).toISOString()}).run();
 beforeStore?.(client);const store=programGrantStore(db),setup=sharedProgramSetup(db,clock,store,()=>({records:['tasks','projects'],operations:['tasks.command']}));return{client,db,clock,store,setup,fingerprint};
}
it('keeps absent and empty restrictions distinct and requires the surrounding token transaction',()=>{
 const f=fixture();expect(f.store.read(f.fingerprint)).toBeUndefined();expect(()=>f.store.write(f.fingerprint,{records:[],operations:[]})).toThrow('token transaction');expect(f.store.read(f.fingerprint)).toBeUndefined();
 f.db.transaction(()=>f.store.write(f.fingerprint,{records:['tasks','projects','tasks'],operations:['tasks.command','tasks.command']}));
 expect(f.store.read(f.fingerprint)).toEqual({records:['projects','tasks'],operations:['tasks.command']});
 f.db.transaction(()=>f.store.write(f.fingerprint,{records:[],operations:[]}));expect(f.store.read(f.fingerprint)).toEqual({records:[],operations:[]});expect(f.db.select().from(programTokens).all()).toEqual([{token:f.fingerprint}]);
});
it('preserves both grants and the empty marker when the actual SQLite store reopens',()=>{
 const home=mkdtempSync(join(tmpdir(),'loom-program-grants-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));const file=join(home,'fiction.db'),f=fixture(file),issued=f.setup.issue({member:'sam',label:'Persistent',records:['tasks'],operations:['tasks.command']});f.client.close();
 const reopened=new Database(file);reopened.pragma('foreign_keys = ON');clean.push(()=>{if(reopened.open)reopened.close();});const db=dataDatabase(reopened),store=programGrantStore(db);expect(store.read(issued.fingerprint)).toEqual({records:['tasks'],operations:['tasks.command']});db.transaction(()=>store.write(issued.fingerprint,{records:[],operations:[]}));reopened.close();
 const final=new Database(file);clean.push(()=>final.close());expect(programGrantStore(dataDatabase(final)).read(issued.fingerprint)).toEqual({records:[],operations:[]});
});
it('rolls token marker and all grants back together when issuance fails partway through SQLite writes',()=>{
 const f=fixture();f.client.exec("CREATE TRIGGER fixture_grant_failure BEFORE INSERT ON program_operation_grants BEGIN SELECT RAISE(ABORT,'fixture rejected operation'); END");
 expect(()=>f.setup.issue({member:'sam',label:'Failed issue',records:['tasks'],operations:['tasks.command']})).toThrow();expect(f.db.select().from(tokens).where(eq(tokens.label,'Failed issue')).all()).toEqual([]);expect(f.db.select().from(programTokens).all()).toEqual([]);expect(f.db.select().from(programRecordGrants).all()).toEqual([]);expect(f.db.select().from(programOperationGrants).all()).toEqual([]);
});
it('restores the previous grants if an edit fails after deleting them',()=>{
 const f=fixture(),issued=f.setup.issue({member:'sam',label:'Edit rollback',records:['tasks'],operations:[]});f.client.exec("CREATE TRIGGER fixture_edit_failure BEFORE INSERT ON program_operation_grants BEGIN SELECT RAISE(ABORT,'fixture rejected operation'); END");
 expect(()=>f.setup.set({fingerprint:issued.fingerprint,records:['projects'],operations:['tasks.command']})).toThrow();expect(f.store.read(issued.fingerprint)).toEqual({records:['tasks'],operations:[]});expect(f.db.select().from(programTokens).all()).toHaveLength(1);
});
it('enforces the grant parent keys names uniqueness and token cleanup in SQLite',()=>{
 const f=fixture();expect(()=>f.db.insert(programTokens).values({token:'missing'}).run()).toThrow();expect(()=>f.db.insert(programRecordGrants).values({token:f.fingerprint,recordType:'tasks'}).run()).toThrow();
 f.db.transaction(()=>f.store.write(f.fingerprint,{records:['tasks'],operations:['tasks.command']}));expect(()=>f.db.insert(programRecordGrants).values({token:f.fingerprint,recordType:'tasks'}).run()).toThrow();expect(()=>f.db.insert(programOperationGrants).values({token:f.fingerprint,operation:''}).run()).toThrow();expect(()=>f.db.insert(programRecordGrants).values({token:f.fingerprint,recordType:'x'.repeat(201)}).run()).toThrow();
 f.db.delete(tokens).where(eq(tokens.fingerprint,f.fingerprint)).run();expect(f.db.select().from(programTokens).all()).toEqual([]);expect(f.db.select().from(programRecordGrants).all()).toEqual([]);expect(f.db.select().from(programOperationGrants).all()).toEqual([]);expect(f.client.pragma('foreign_key_check')).toEqual([]);
});

it('keeps one coherent snapshot when another connection replaces grants at the read boundary',()=>{
 const home=mkdtempSync(join(tmpdir(),'loom-program-snapshot-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));let replace!:()=>void,interleaved=false;
 const f=fixture(join(home,'fiction.db'),client=>{const prepare=client.prepare.bind(client);vi.spyOn(client,'prepare').mockImplementation(source=>{const prepared=prepare(source);if(/^\s*select/i.test(source)&&source.includes('program_record_grants')){const all=prepared.all.bind(prepared);vi.spyOn(prepared,'all').mockImplementation((...args:unknown[])=>{const rows=all(...args);if(!interleaved){interleaved=true;replace();}return rows;});}return prepared;});});f.client.pragma('journal_mode = WAL');
 f.db.transaction(()=>f.store.write(f.fingerprint,{records:['tasks'],operations:['tasks.command']}));const other=new Database(join(home,'fiction.db'));other.pragma('foreign_keys = ON');clean.push(()=>other.close());const otherDb=dataDatabase(other),otherStore=programGrantStore(otherDb);replace=()=>otherDb.transaction(()=>otherStore.write(f.fingerprint,{records:['projects'],operations:['projects.read']}));
 const snapshot=f.store.read(f.fingerprint);expect(interleaved).toBe(true);expect(snapshot).toEqual({records:['tasks'],operations:['tasks.command']});expect(otherStore.read(f.fingerprint)).toEqual({records:['projects'],operations:['projects.read']});expect(Object.isFrozen(snapshot)).toBe(true);expect(Object.isFrozen(snapshot!.records)).toBe(true);expect(Object.isFrozen(snapshot!.operations)).toBe(true);
});
it('enforces both grant lists uniqueness and both name-length bounds',()=>{
 const f=fixture();f.db.transaction(()=>f.store.write(f.fingerprint,{records:['tasks'],operations:['tasks.command']}));expect(()=>f.db.insert(programOperationGrants).values({token:f.fingerprint,operation:'tasks.command'}).run()).toThrow();
 for(const name of ['', 'x'.repeat(201)]){expect(()=>f.db.insert(programRecordGrants).values({token:f.fingerprint,recordType:name}).run()).toThrow();expect(()=>f.db.insert(programOperationGrants).values({token:f.fingerprint,operation:name}).run()).toThrow();}
});

it('keeps a coherent batch snapshot while another connection replaces both grant lists',()=>{
 const home=mkdtempSync(join(tmpdir(),'loom-program-batch-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));let replace!:()=>void,interleaved=false;
 const f=fixture(join(home,'fiction.db'),client=>{const prepare=client.prepare.bind(client);vi.spyOn(client,'prepare').mockImplementation(source=>{const prepared=prepare(source);if(/^\s*select/i.test(source)&&source.includes('"program_tokens"')){const all=prepared.all.bind(prepared);vi.spyOn(prepared,'all').mockImplementation((...args:unknown[])=>{const rows=all(...args);if(!interleaved){interleaved=true;replace();}return rows;});}return prepared;});});
 f.client.pragma('journal_mode = WAL');f.db.transaction(()=>f.store.write(f.fingerprint,{records:['tasks'],operations:['tasks.command']}));
 const other=new Database(join(home,'fiction.db'));other.pragma('foreign_keys = ON');clean.push(()=>other.close());const otherDb=dataDatabase(other),otherStore=programGrantStore(otherDb);
 replace=()=>otherDb.transaction(()=>otherStore.write(f.fingerprint,{records:['projects'],operations:['projects.read']}));
 const snapshot=f.store.readMany([f.fingerprint,'missing']);expect(interleaved).toBe(true);
 expect(snapshot.get(f.fingerprint)).toEqual({records:['tasks'],operations:['tasks.command']});expect(snapshot.has('missing')).toBe(false);
 expect(otherStore.read(f.fingerprint)).toEqual({records:['projects'],operations:['projects.read']});expect(Object.isFrozen(snapshot.get(f.fingerprint))).toBe(true);
 f.db.transaction(()=>f.store.write(f.fingerprint,{records:[],operations:[]}));expect(f.store.readMany([f.fingerprint]).get(f.fingerprint)).toEqual({records:[],operations:[]});
});
