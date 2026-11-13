import {afterEach,expect,it}from'vitest';
import Database from'better-sqlite3';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync}from'node:fs';
import {tmpdir}from'node:os';
import {join,dirname}from'node:path';
import {createSnapshot}from'./migration-snapshot.js';
import {prepareMigrationPlan}from'./migration-plan.js';
import {runMigrationAll}from'./migration-all.js';
import {verifyMigration,verifyBridgesMigration}from'./migration-verify.js';
import {migrateBridges}from'./migrate-bridges.js';
import {Readable}from'node:stream';
import {createFoundation}from'../core/app.js';
import {importHousehold}from'./household-importer.js';
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'migration-bridges-'));roots.push(root);const old=join(root,'old'),instance=join(root,'instance'),snapshot=join(root,'snapshot'),home=join(root,'new');
 const put=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));};
 put(join(old,'household.json'),{v:1,agents:['art'],default:'art',owner:'jonathan'});
 put(join(instance,'shuttle.json'),{agent:{slug:'art'},discord:{token_file:'/never-open'}});
 put(join(instance,'people.json'),{people:{jonathan:{discord:['123']}}});
 put(join(instance,'routes.json'),{guild:'789',bots:{art:'100'},channels:{'300':{primary:'art'}}});
 writeFileSync(join(instance,'credentials'),'do not collect');
 const storePath=join(old,'commons/stores/shuttle.db');mkdirSync(dirname(storePath),{recursive:true});const store=new Database(storePath);
 store.exec('CREATE TABLE docs(collection TEXT,key TEXT,doc TEXT,rev INTEGER,updated TEXT,by TEXT);CREATE TABLE revisions(id INTEGER,collection TEXT,key TEXT,doc TEXT,rev INTEGER,op TEXT,at TEXT,by TEXT)');
 store.prepare('INSERT INTO docs VALUES (?,?,?,1,?,?)').run('unknown','private','{"raw":9007199254740991.1}','today','owner');store.close();
 await createSnapshot(old,snapshot,undefined,{bridges:[instance]});
 const plan=prepareMigrationPlan(snapshot).plan;plan.importers.bridges.options={...(plan.importers.bridges.options as object),connections:[{agent:'art',platform:'discord',workspace:'789',bot:'100',tokenSecret:'art-discord'}]};
 return{root,old,instance,snapshot,home,plan};
}
it('collects only explicit external instance files and completes all with independent evidence comparison',async()=>{
 const f=await fixture();expect(existsSync(join(f.snapshot,'bridges/0/credentials'))).toBe(false);expect(readFileSync(join(f.snapshot,'bridges/0/shuttle.json'))).toEqual(readFileSync(join(f.instance,'shuttle.json')));
 expect(f.plan.importers.bridges.paths).toEqual(['bridges/0/people.json','bridges/0/routes.json','bridges/0/shuttle.json','home/commons/stores/shuttle.db']);
 expect((await runMigrationAll(f.snapshot,f.home,f.plan)).status).toBe('complete');
 expect((await verifyMigration(f.snapshot,f.home,f.plan)).status).toBe('verified');
 expect((await verifyBridgesMigration(f.snapshot,f.home,f.plan.importers.bridges.options)).status).toBe('verified');
 const db=new Database(join(f.home,'loom.db'));db.prepare("UPDATE bridges_meta SET value='{}' WHERE key='legacy-evidence'").run();db.close();
 for(const report of [await verifyMigration(f.snapshot,f.home,f.plan),await verifyBridgesMigration(f.snapshot,f.home,f.plan.importers.bridges.options)]){expect(report.status).toBe('different');expect(report.differences).toContainEqual(expect.objectContaining({piece:'bridges',table:'bridges_meta'}));}
});
it('standalone imports only from the completed snapshot with explicit mapping and existing matching household',async()=>{
 const f=await fixture(),app=createFoundation({home:f.home});importHousehold(app.db,f.home,join(f.snapshot,'home'),1);app.close();
 const mapping=join(f.root,'mapping.json');writeFileSync(mapping,JSON.stringify(f.plan.importers.bridges.options));let out='',err='';
 const io={env:{},stdin:Readable.from([]),stdout:(s:string)=>{out+=s;},stderr:(s:string)=>{err+=s;}};
 expect(await migrateBridges(['--home',f.home,'--from',f.snapshot,'--mapping',mapping],io)).toBe(0);expect(err).toBe('');expect(JSON.parse(out).imported).toBe(true);
 expect((await verifyBridgesMigration(f.snapshot,f.home,f.plan.importers.bridges.options)).status).toBe('verified');
});
it('refuses plans omitting any selected store and incomplete instance mappings',async()=>{
 const f=await fixture();f.plan.importers.bridges.paths.pop();expect(()=>prepareMigrationPlan(f.snapshot,f.plan)).toThrow('every discovered source');
});
