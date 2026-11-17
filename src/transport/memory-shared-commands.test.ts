/** Existing Memory commands on the shared write/receipt boundary. No legacy
 * Foundation, Live or household tables; the browser command door is separate. */
import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {eq} from 'drizzle-orm';
import {FakeClock} from '../core/clock.js';
import {createDataSchema} from '../core/data/database.js';
import {members,tokens,agents} from '../core/data/schema.js';
import {DataWrites} from '../core/data/writes.js';
import {OperationResults,type ReceiptPersistence} from '../core/data/operation-results.js';
import {Operations} from '../core/operations/index.js';
import {nextData} from '../next-data.js';
import {SqliteKnowledgeBackend} from '../backends/sqlite-knowledge.js';
import {PeopleStore} from '../backends/people.js';
import {verifyKnowledgePages,deriveSlaClass} from '../backends/knowledge-verification.js';
import {createPersonHalf} from '../backends/people-creation.js';
import {installMindKnowledgeActions} from '../pieces/mind/actions.js';
import {installMindPeopleActions} from '../pieces/mind/people-actions.js';
import {migrateMindReceipts} from '../pieces/mind/receipt-schema.js';
import {knowledgeQueryFields} from '../pieces/mind/knowledge-query.js';
import {peopleQueryFields} from '../pieces/mind/people-query.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(){
 const home=mkdtempSync(join(tmpdir(),'memory-shared-command-'));closes.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock(),client=new Database(':memory:'),db=createDataSchema(client),at=new Date(clock.now()).toISOString(),raw='d'.repeat(64);
 closes.push(()=>client.close());db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();
 db.insert(agents).values({id:'fiction',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(tokens).values({fingerprint:createHash('sha256').update(raw).digest('hex'),label:'Fictional bearer',kind:'owner',member:'owner',createdAt:at}).run();
 const sharing=()=>({members:{owner:{owner:db.select().from(members).where(eq(members.id,'owner')).get()?.role==='owner',agents:[]}},projects:{},services:{}});
 const tables=()=>client.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all(),initialTables=tables();
 const path=join(home,'knowledge.db'),directory=join(home,'people.db'),relationship=join(home,'memories.db');
 const source=new SqliteKnowledgeBackend({dbPath:path});closes.push(()=>source.close());await source.writePage({slug:'pump',title:'Fictional pump',domain:'fiction',body:'Fictional pump words'});
 for(const dbPath of [directory,relationship])new PeopleStore({dbPath}).close();
 for(const dbPath of [path,directory,relationship]){const prepared=new Database(dbPath);try{migrateMindReceipts(prepared);}finally{prepared.close();}}
 const knowledge=knowledgeQueryFields({path,sharing,now:()=>clock.now()}),people=peopleQueryFields({directory,agents:[{agent:'fiction',directory:home,memories:relationship}],sharing,now:()=>clock.now(),projectHref:(_agent,slug)=>'/project/'+slug});
 closes.push(()=>knowledge.close(),()=>people.close());
 const data=nextData(db,clock,()=>true,undefined,{...knowledge.fields,...people.fields});
 const published=vi.fn(()=>data.changed()),writes=new DataWrites(db,{refreshAccess(){},changed:published}),stored=new OperationResults(db);
 let failReceipt=false,failRelationship=false;
 const receipts:ReceiptPersistence={get:stored.get.bind(stored),expire:stored.expire.bind(stored),nextExpiry:stored.nextExpiry.bind(stored),recover:stored.recover.bind(stored),insert(receipt){if(failReceipt)throw Error('Fictional shared receipt failure');stored.insert(receipt);}};
 const changes=vi.fn(),operations=new Operations(client,clock,changes,{receipts,writes,reportError:()=>{}});
 const knowledgeActions=installMindKnowledgeActions(operations,{path,sharing,verify:verifyKnowledgePages,classify:(domain,anchor)=>deriveSlaClass(anchor,domain)});
 const peopleActions=installMindPeopleActions(operations,{directory,relationship,agent:'fiction',sharing,create(db,input,now,half){if(half==='relationship'&&failRelationship)throw Error('Fictional relationship interruption');createPersonHalf(db,input,now,half);}});
 closes.push(()=>knowledgeActions.close(),()=>peopleActions.close(),()=>operations.close(),()=>data.close());
 const call=(name:string,input:unknown,id:string)=>operations.call('http',{kind:'member',id:'owner'},name,input,id);
 const read=async(query:string)=>{const response=await data.http.request('http://loom/graphql',{method:'POST',headers:{authorization:'Bearer '+raw,'content-type':'application/json'},body:JSON.stringify({query})});expect(response.status).toBe(200);const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
 return {client,db,source,operations,published,changes,call,read,tables,initialTables,directory,relationship,failReceipt(v:boolean){failReceipt=v;},failRelationship(v:boolean){failRelationship=v;}};
}
it('recovers a committed Knowledge source effect after shared receipt failure without duplicate notes',async()=>{
 const f=await fixture(),before=f.initialTables;f.failReceipt(true);
 expect(f.call('mind.knowledgeVerify',{slug:'pump'},'check')).toMatchObject({code:'unavailable'});
 expect(await f.source.getVerifications('pump')).toHaveLength(1);expect(f.client.prepare('SELECT count(*) AS n FROM operation_results').get()).toEqual({n:0});expect(f.published).not.toHaveBeenCalled();
 f.failReceipt(false);const result=f.call('mind.knowledgeVerify',{slug:'pump'},'check');expect(result).toMatchObject({ok:true,value:{slugs:['pump']}});
 expect(f.call('mind.knowledgeVerify',{slug:'pump'},'check')).toEqual(result);expect(await f.source.getVerifications('pump')).toHaveLength(1);
 expect(f.changes).toHaveBeenCalledWith([{type:'knowledge',id:'pump'}]);expect(f.published).toHaveBeenCalled();
 expect(await f.read('{ memoryKnowledgePage(slug:"pump") { checked { by outcome } } }')).toMatchObject({memoryKnowledgePage:{checked:{by:'owner',outcome:'confirmed'}}});
 f.db.update(members).set({role:'member'}).run();expect(f.call('mind.knowledgeRecheck',{slug:'pump'},'fresh')).toMatchObject({code:'denied'});
 expect(await f.source.getVerifications('pump')).toHaveLength(1);expect(await f.read('{ memoryKnowledge { total } }')).toEqual({memoryKnowledge:null});expect(f.tables()).toEqual(before);
});
it('resumes a half-saved person into both own source files and publishes canonical scopes once complete',async()=>{
 const f=await fixture(),before=f.initialTables,input={name:'Fictional friend',summary:'Private relationship',channel:'email',handle:'fiction@example.invalid'};
 f.failRelationship(true);expect(f.call('mind.personAdd',input,'person')).toMatchObject({code:'unavailable'});expect(f.published).not.toHaveBeenCalled();
 f.failRelationship(false);const result=f.call('mind.personAdd',input,'person');expect(result).toMatchObject({ok:true,value:{slug:'fictional-friend'}});expect(f.call('mind.personAdd',input,'person')).toEqual(result);
 expect(f.changes).toHaveBeenCalledWith([{type:'person',id:'commons:fictional-friend'},{type:'person',id:'fiction:fictional-friend'}]);
 expect(await f.read('{ memoryPeople { id name card { summary where { key value { text } } } } }')).toMatchObject({memoryPeople:[{id:'commons:fictional-friend',name:'Fictional friend',card:{where:[{key:'email',value:{text:'fiction@example.invalid'}}]}},{id:'fiction:fictional-friend',card:{summary:'Private relationship'}}]});
 expect(f.client.prepare('SELECT count(*) AS n FROM operation_results').get()).toEqual({n:1});expect(f.tables()).toEqual(before);
});
it('saves neither half of a person when the relationship half fails, so the name can be added again later',async()=>{
 const f=await fixture(),input={name:'Fictional friend',summary:'Private relationship',channel:'email',handle:'fiction@example.invalid'};
 f.failRelationship(true);expect(f.call('mind.personAdd',input,'first')).toMatchObject({code:'unavailable'});
 expect(await f.read('{ memoryPeople { id } }')).toEqual({memoryPeople:[]});
 // A different operation id: the first attempt's receipt is not what makes this one work.
 f.failRelationship(false);expect(f.call('mind.personAdd',input,'second')).toMatchObject({ok:true,value:{slug:'fictional-friend'}});
 expect((await f.read('{ memoryPeople { id } }')).memoryPeople.map((person:{id:string})=>person.id)).toEqual(['commons:fictional-friend','fiction:fictional-friend']);
});
it('finishes a person whose relationship half alone survived a crash, on a retry with the same operation id',async()=>{
 const f=await fixture(),input={name:'Fictional friend',summary:'Private relationship',channel:'',handle:''};
 expect(f.call('mind.personAdd',input,'person')).toMatchObject({ok:true});
 // As a crash between the two commits leaves it: no directory card, no directory receipt, no shared receipt.
 const directory=new Database(f.directory);try{directory.exec('DELETE FROM people;DELETE FROM mind_operation_receipts');}finally{directory.close();}
 f.client.exec('DELETE FROM operation_results');
 expect(f.call('mind.personAdd',input,'person')).toMatchObject({ok:true,value:{slug:'fictional-friend'}});
 expect((await f.read('{ memoryPeople { id } }')).memoryPeople.map((person:{id:string})=>person.id)).toEqual(['commons:fictional-friend','fiction:fictional-friend']);
 expect(f.call('mind.personAdd',input,'another')).toMatchObject({code:'conflict'});
});
it('adds a person through the card store, so its rules for a summary and for a merged address hold',async()=>{
 const f=await fixture();
 expect(f.call('mind.personAdd',{name:'Fictional friend',summary:'Private relationship',channel:'',handle:''},'person')).toMatchObject({ok:true});
 const relationship=new Database(f.relationship);
 try{
  // A card written with a summary records when that summary was written.
  expect(relationship.prepare("SELECT synthesized_at IS NOT NULL AS dated FROM people WHERE slug='fictional-friend'").get()).toEqual({dated:1});
  // An address that was merged into another card leads there; a new card behind it would never be read.
  relationship.prepare("INSERT INTO person_merges (from_slug,into_slug,merged_at,merged_by,counts_json) VALUES ('old-friend','fictional-friend','2026-11-15T00:00:00.000Z',NULL,'{}')").run();
 }finally{relationship.close();}
 expect(f.call('mind.personAdd',{name:'Old friend',summary:'',channel:'',handle:''},'merged')).toMatchObject({code:'conflict'});
 expect((await f.read('{ memoryPeople { id } }')).memoryPeople.map((person:{id:string})=>person.id)).toEqual(['commons:fictional-friend','fiction:fictional-friend']);
});
