import {afterEach,expect,it,vi}from'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
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
const roots:string[]=[];afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
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

it('both verifiers detect adapter receipt/session rows independently of import receipts',async()=>{
 const f=await fixture();await runMigrationAll(f.snapshot,f.home,f.plan);
 for(const [table,sql]of [
  ['bridges_discord_sessions',"INSERT INTO bridges_discord_sessions VALUES ('binding','checkpoint')"],
  ['bridges_discord_receipts',"INSERT INTO bridges_discord_receipts VALUES ('r','v','b','m','private','pending',1)"],
  ['bridges_slack_receipts',"INSERT INTO bridges_slack_receipts VALUES ('r','v','b','e','private','pending',1)"],
 ]){
  const d=new Database(join(f.home,'loom.db'));d.exec(sql);d.close();
  for(const report of [await verifyMigration(f.snapshot,f.home,f.plan),await verifyBridgesMigration(f.snapshot,f.home,f.plan.importers.bridges.options)])expect(report.differences).toContainEqual(expect.objectContaining({piece:'bridges',table,expected:0,actual:1}));
  const clean=new Database(join(f.home,'loom.db'));clean.exec(`DELETE FROM ${table}`);clean.close();
 }
});

it('both verifiers derive every setup row from source rather than a receipt',async()=>{
 const f=await fixture();await runMigrationAll(f.snapshot,f.home,f.plan);
 for(const table of ['bridges_venues','bridges_routes','bridges_links']){
  const d=new Database(join(f.home,'loom.db')),row=d.prepare(`SELECT id,record FROM ${table}`).get() as{id:string;record:string};d.prepare(`UPDATE ${table} SET record=? WHERE id=?`).run(JSON.stringify({...JSON.parse(row.record),unexpected:'tampered'}),row.id);d.close();
  for(const report of [await verifyMigration(f.snapshot,f.home,f.plan),await verifyBridgesMigration(f.snapshot,f.home,f.plan.importers.bridges.options)])expect(report.differences).toContainEqual(expect.objectContaining({piece:'bridges',table,expected:1,actual:1}));
  const clean=new Database(join(f.home,'loom.db'));clean.prepare(`UPDATE ${table} SET record=? WHERE id=?`).run(row.record,row.id);clean.close();
 }
});

it('rehearses the household shape: one local root, three bots, a work Slack bundle and no split names',async()=>{
 const outside=vi.fn(()=>{throw Error('offline migration attempted venue IO');});
 vi.stubGlobal('fetch',outside);
 vi.spyOn(http,'request').mockImplementation(outside);vi.spyOn(https,'request').mockImplementation(outside);
 vi.spyOn(net,'connect').mockImplementation(outside);
 const root=mkdtempSync(join(tmpdir(),'bridges-household-'));roots.push(root);
 const old=join(root,'old'),instance=join(root,'instance'),snapshot=join(root,'snapshot'),home=join(root,'new');
 const put=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));};
 put(join(old,'household.json'),{v:1,agents:['art','mark'],default:'art',owner:'jonathan'});
 put(join(old,'pieces/discord/settings.json'),{DISCORD_BOTS:JSON.stringify({art:'discord-token',mark:'mark-discord-token'})});
 put(join(old,'pieces/slack/settings.json'),{SLACK_BOTS:JSON.stringify({art:'slack-onterris.env'})});
 put(join(instance,'shuttle.json'),{_comment:'fixture',agent:{slug:'art',name:'Art',tag:'Art'},owner:{name:'Jonathan'},workdir:'/never/work',state_root:'/never/state',inbox_dir:'/never/inbox',now_dir:'/never/now',secret_cmd:'never run',commands:{claude:'never',loom:'never',alert:'never',model:'never',send:{discord:'never',slack:'never'}},preferred_model:'fixture',always_deny:['never'],runner:{kind:'claude',host:{discord:'discord-bodies'}},upgrade_ignore:['never'],guest_deny:['never'],channel_notes:{onterris_channels:'discord-onterris'},briefs:'briefs',ext:'ext/art.py',discord:{token_file:'discord-token',guest_cap_note:'fixture',packages:{routes_key:'fixture',package_watch:'never',python:'never'}},slack:{secrets_env:'slack-onterris.env',flag_to:{via:'discord',chan_from_routes:'notify.general'},projects:{file:'projects.json',pond_field:'fixture'},workspaces:{TWORK:'Work'}}});
 put(join(instance,'people.json'),{_comment:'fixture',_updated:'today',agents:{_note:'human annotation',art:{discord:['100']},mark:{discord:['200']},fez:{discord:['250']}},people:{jonathan:{discord:['123'],slack:{TWORK:['UOWNER']}},guest:{discord:['456']}}});
 put(join(instance,'routes.json'),{_comment:'fixture',_updated:'today',guild:'789',bots:{art:'100',mark:'200',fez:'250'},_bot_roles_note:'fixture',bot_roles:{art:['101'],mark:['201'],fez:['251']},webhook_peers:{_comment:'x'.repeat(395),one:'800',two:'801',three:'802'},peer_turns_each:null,_peer_turns_note:'fixture',_ids_note:'fixture',ignore:{'900':true},channels:{'300':{primary:'art',_note:'channel annotation',onterris:true},'301':{primary:'mark',_note:'channel annotation',onterris:false},'302':{primary:'fez'},'303':{primary:'art',readers:['guest']}},threads:{'304':{primary:'art',parent:'303'}}});
 writeFileSync(join(instance,'slack-onterris.env'),'NEVER_OPEN_BUNDLE');
 const store=(kind:string,docs:[string,string,unknown][])=>{const path=join(old,`commons/stores/${kind}.db`);mkdirSync(dirname(path),{recursive:true});const d=new Database(path);d.exec('CREATE TABLE docs(collection TEXT,key TEXT,doc TEXT,rev INTEGER,updated TEXT,by TEXT);CREATE TABLE revisions(id INTEGER,collection TEXT,key TEXT,doc TEXT,rev INTEGER,op TEXT,at TEXT,by TEXT)');for(const[c,k,v]of docs)d.prepare('INSERT INTO docs VALUES (?,?,?,1,?,?)').run(c,k,JSON.stringify(v),'today','owner');d.close();};
 const legacyPeople=JSON.parse(readFileSync(join(instance,'people.json'),'utf8'));
 const commonFlags={'303':{readers:['guest']},'305':{peer:true,pair:'mark'}};
 store('shuttle',[
  ['moved','art',{}],['people','art',{people:{stale:{discord:['999']}}}],
  ['routes','household',{guild:'789',channel_names:{'300':'Art','301':'Mark','302':'Fez','303':'Guest'}}],
  ['channels','art',{bot:'100',bot_role:['101'],answers:{'300':'Art','303':'Guest'},flags:{...commonFlags,'306':{peer:true},'307':{peer:true,guest_venue:true,readers:['jonathan']}},threads:{'304':{primary:'art',parent:'303'}}}],
  ['channels','mark',{bot:'200',bot_role:['201'],answers:{'301':'Mark'},flags:commonFlags}],
  ['channels','fez',{bot:'250',bot_role:['251'],answers:{'302':'Fez'}}],
 ]);
 store('runtime',[['gates','art',legacyPeople]]);
 const state=join(root,'runtime'),data=join(root,'runtime-data');mkdirSync(state);mkdirSync(data);
 await createSnapshot(old,snapshot,undefined,{bridges:[instance],runtime:state,'runtime-data':data});
 const plan=prepareMigrationPlan(snapshot).plan;
 expect(plan.importers.bridges.options).toMatchObject({instances:[{shuttle:'bridges/0/shuttle.json'}],connections:[]});
 plan.importers.bridges.options={...(plan.importers.bridges.options as object),connections:[{agent:'art',platform:'discord',workspace:'789',bot:'100',tokenSecret:'discord-token'},{agent:'art',platform:'slack',workspace:'TWORK',setupIncomplete:true}]};
 expect(existsSync(join(snapshot,'bridges/0/slack-onterris.env'))).toBe(false);
 expect((await runMigrationAll(snapshot,home,plan)).status).toBe('complete');
 expect((await verifyMigration(snapshot,home,plan)).status).toBe('verified');
 expect((await verifyBridgesMigration(snapshot,home,plan.importers.bridges.options)).status).toBe('verified');
 const d=new Database(join(home,'loom.db'));
 try{
  const venues=d.prepare('SELECT record FROM bridges_venues').all() as{record:string}[];
  expect(venues.map(v=>JSON.parse(v.record))).toEqual([expect.objectContaining({agent:'art',platform:'discord',enabled:false,tokenSecret:'discord-token'})]);
  expect(JSON.parse(venues[0].record).ignore).toEqual(expect.arrayContaining(['302','303','305','306','307']));
  const routes=d.prepare('SELECT record FROM bridges_routes').all() as{record:string}[];
  expect(routes.map(r=>JSON.parse(r.record).channel).sort()).toEqual(['300','301']);
  expect((d.prepare('SELECT record FROM bridges_links').all() as{record:string}[]).map(r=>JSON.parse(r.record).person)).toEqual(['jonathan','jonathan']);
  const evidence=JSON.parse((d.prepare("SELECT value FROM bridges_meta WHERE key='legacy-evidence'").get() as{value:string}).value);
  expect(evidence.retained).toContainEqual(expect.objectContaining({source:'shuttle.db',collection:'channels',agent:'art',path:['channels','art','flags','307','readers']}));
  expect(evidence.retained).toContainEqual(expect.objectContaining({agent:'mark',path:['channels','mark','flags','305','pair']}));
  expect(evidence.incomplete).toEqual([expect.objectContaining({agent:'art',platform:'slack',workspace:'TWORK',bundle:'slack-onterris.env'})]);
  expect(evidence.retained).toEqual(expect.arrayContaining([expect.objectContaining({kind:'person',owner:'guest'}),expect.objectContaining({kind:'agent',owner:'fez'}),expect.objectContaining({kind:'route',channel:'302'}),expect.objectContaining({kind:'route',channel:'303'}),expect.objectContaining({kind:'route',channel:'304'})]));
  // Independent verification also covers incomplete/retained evidence, not just live setup.
  d.prepare("UPDATE bridges_meta SET value='{}' WHERE key='legacy-evidence'").run();
 }finally{d.close();}
 expect((await verifyMigration(snapshot,home,plan)).status).toBe('different');
 expect((await verifyBridgesMigration(snapshot,home,plan.importers.bridges.options)).status).toBe('different');
 expect(outside).not.toHaveBeenCalled();
});
