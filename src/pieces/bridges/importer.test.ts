import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';
import {tmpdir}from'node:os';
import {join,dirname}from'node:path';
import {openDb}from'../../core/index.js';
import {importBridges}from'./importer.js';
import {readBridgeImport,type BridgeImportSources}from'./import-plan.js';
import {addressed}from'./routing.js';
import type {BridgeSourceFile}from'./import-source.js';
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const h={agents:['art','mark'],members:['jonathan','loren']};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'bridges-import-'));roots.push(root);
 const file=(name:string,kind:BridgeSourceFile['kind'],value:unknown)=>{const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));return{name,path,kind};};
 const sources:BridgeImportSources={files:[file('instance/shuttle.json','shuttle',{agent:{slug:'art'},discord:{token_file:'/never/open'}}),file('instance/people.json','people',{people:{jonathan:{discord:['123']}}}),file('instance/routes.json','routes',{guild:'789',bots:{art:'100'},channels:{'300':{primary:'art'}}})],stores:[]};
 const options={instances:[{shuttle:'instance/shuttle.json',people:'instance/people.json',routes:'instance/routes.json'}],connections:[{agent:'art',platform:'discord',workspace:'789',bot:'100',tokenSecret:'art-discord'}]};
 const store=(kind:'shuttle'|'runtime',docs:[string,string,unknown][])=>{
  const path=join(root,`${kind}.db`),d=new Database(path);d.exec('CREATE TABLE docs(collection TEXT,key TEXT,doc TEXT,rev INTEGER,updated TEXT,by TEXT);CREATE TABLE revisions(id INTEGER,collection TEXT,key TEXT,doc TEXT,rev INTEGER,op TEXT,at TEXT,by TEXT)');
  for(const[c,k,v]of docs)d.prepare('INSERT INTO docs VALUES (?,?,?,1,?,?)').run(c,k,JSON.stringify(v),'today','owner');d.close();sources.stores.push({name:`${kind}.db`,path,kind});
 };
 const open=(path:string)=>new Database(path,{readonly:true,fileMustExist:true});return{root,sources,options,store,open};
}
it('imports source-derived disabled setup, compares every row, repeats and refuses a changed mapping',()=>{
 const f=fixture(),{db,close}=openDb(join(f.root,'new'));
 try{
  const result=importBridges(db,f.sources,f.options,h,f.open);expect(result.imported).toBe(true);
  expect(JSON.parse((db.prepare('SELECT record FROM bridges_venues').get()as{record:string}).record)).toMatchObject({enabled:false,agent:'art',bot:'100',tokenSecret:'art-discord'});
  expect(JSON.parse((db.prepare('SELECT record FROM bridges_links').get()as{record:string}).record)).toMatchObject({person:'jonathan',user:'123'});
  expect(importBridges(db,f.sources,f.options,h,f.open).imported).toBe(false);
  expect(()=>importBridges(db,f.sources,{...f.options,connections:[{...f.options.connections[0],tokenSecret:'different'}]},h,f.open)).toThrow('different Bridges source');
 }finally{close();}
});
it('rolls back schema and rows on interruption and refuses populated destinations',()=>{
 const f=fixture(),{db,close}=openDb(join(f.root,'new'));try{
 expect(()=>importBridges(db,f.sources,f.options,h,f.open,{interrupt:()=>{throw Error('interrupted');}})).toThrow('interrupted');
 expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridges_venues'").get()).toBeUndefined();
 importBridges(db,f.sources,f.options,h,f.open);db.prepare("DELETE FROM bridges_meta WHERE key='source-checksum'").run();
 expect(()=>importBridges(db,f.sources,f.options,h,f.open)).toThrow('must be empty');
 }finally{close();}
});
it('selects Runtime people before shuttle and file, retaining every exact private store row',()=>{
 const f=fixture();f.store('shuttle',[['people','art',{people:{loren:{discord:['456']}}}],['moved','art',{}],['proposals','pending',{discord:['bad']}]]);
 f.store('runtime',[['gates','art',{people:{jonathan:{discord:['999']}}}],['unknown','private',{opaque:'words'}]]);
 const s=readBridgeImport(f.sources,f.options,h,f.open);expect(s.expected.links.map(l=>l.user)).toEqual(['999']);
 expect(JSON.parse(s.evidence).stores.stores.flatMap((s:{documents:unknown[]})=>s.documents)).toHaveLength(5);
});
it('refuses moved-without-Runtime rather than falling back to stale people',()=>{
 const f=fixture();f.store('shuttle',[['moved','art',{}],['people','art',{people:{jonathan:{discord:['old']}}}]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow('Invalid offline');
});
it('assembles all accepted agent parts and flags, never proposal flags',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789',channel_names:{'300':'work'}}],['channels','art',{bot:'100',answers:{'300':'work'},flags:{'300':{guest_venue:true,readers:['jonathan']}}}],['channels','mark',{bot:'200',flags:{'300':{guest_venue:true,readers:['jonathan']}},answers:{'400':'mark'},threads:{'500':{primary:'mark',parent:'400',peer:true}}}],['route-offers','art',{at:123.25,doc:{bots:{art:'100',mark:'200'},channels:{'300':{peer:true}}}}]]);
 f.options.connections.push({agent:'mark',platform:'discord',workspace:'789',bot:'200',tokenSecret:'mark-discord'});
 const s=readBridgeImport(f.sources,f.options,h,f.open);expect(s.expected.routes).toEqual(expect.arrayContaining([expect.objectContaining({channel:'300',guest:true,peer:false,readers:['jonathan']}),expect.objectContaining({channel:'400',primary:'mark'}),expect.objectContaining({channel:'500',parent:'400',peer:false})]));
});
it('falls back to files when accepted routes lack an offered agent part',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'wrong'}],['channels','art',{bot:'wrong'}],['route-offers','art',{doc:{bots:{art:'100',mark:'200'}}}]]);
 expect(readBridgeImport(f.sources,f.options,h,f.open).expected.venues[0].workspace).toBe('789');
});
it('refuses contradictory identities, route claims and incomplete mapping',()=>{
 const f=fixture();writeFileSync(f.sources.files[1].path,JSON.stringify({people:{jonathan:{discord:['123']},loren:{discord:['123']}}}));
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow();
 writeFileSync(f.sources.files[1].path,'{}');f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',answers:{'300':'a'}}],['channels','mark',{bot:'200',answers:{'300':'b'}}]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow();
 expect(()=>readBridgeImport(f.sources,{...f.options,connections:[]},h,f.open)).toThrow();
});

it('refuses agent bot/person collisions after both accepted connections resolve',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100'}],['channels','mark',{bot:'200'}]]);
 f.options.connections.push({agent:'mark',platform:'discord',workspace:'789',bot:'200',tokenSecret:'mark-discord'});
 expect(readBridgeImport(f.sources,f.options,h,f.open).expected.links[0].user).toBe('123');
 for(const bot of ['100','200']){
  writeFileSync(f.sources.files[1].path,JSON.stringify({people:{jonathan:{discord:[bot]}}}));
  expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow();
 }
});
it('blocks partial flags from another accepted agent and inherits parent rules for threads',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',answers:{'300':'a'},threads:{'500':{parent:'300',primary:'art',peer:false}},flags:{'300':{peer:true}}}]]);
 expect(readBridgeImport(f.sources,f.options,h,f.open).expected.routes.find(r=>r.channel==='500')?.peer).toBe(true);
 const d=new Database(f.sources.stores[0].path);d.prepare('INSERT INTO docs VALUES (?,?,?,1,?,?)').run('channels','mark',JSON.stringify({bot:'200',answers:{'400':'b'},flags:{'400':{guest_venue:true}}}),'now','owner');d.close();
 const result=readBridgeImport(f.sources,f.options,h,f.open);
 expect(result.expected.routes).toEqual([]);expect(result.expected.venues[0].ignore).toEqual(expect.arrayContaining(['300','400']));
 expect(JSON.parse(result.evidence).retained).toContainEqual(expect.objectContaining({source:'shuttle.db',collection:'channels',agent:'art',path:['channels','art','flags','300','peer']}));
});
it('requires explicit Slack team/bot/app and token secret names without opening a whole bundle',()=>{
 const f=fixture();writeFileSync(f.sources.files[0].path,JSON.stringify({agent:{slug:'art'},slack:{secrets_env:'/never-open-bundle'}}));writeFileSync(f.sources.files[2].path,'{}');writeFileSync(f.sources.files[1].path,JSON.stringify({people:{jonathan:{slack:{T1:['U1']}}}}));
 const connection={agent:'art',platform:'slack',workspace:'T1',bot:'B1',tokenSecret:'art-slack-token',appSecret:'art-slack-app'};
 const options={...f.options,connections:[connection]};
 expect(readBridgeImport(f.sources,options,h,f.open).expected.venues[0]).toMatchObject({...connection,enabled:false});
 expect(()=>readBridgeImport(f.sources,{...options,connections:[{...connection,appSecret:connection.tokenSecret}]},h,f.open)).toThrow();
 for(const key of ['workspace','bot','tokenSecret','appSecret']){const c={...connection} as Record<string,unknown>;delete c[key];expect(()=>readBridgeImport(f.sources,{...options,connections:[c]},h,f.open)).toThrow();}
});
it('checks private adapter tables for emptiness and comparison',()=>{
 const f=fixture(),{db,close}=openDb(join(f.root,'new'));try{
 importBridges(db,f.sources,f.options,h,f.open);db.prepare("DELETE FROM bridges_meta WHERE key='source-checksum'").run();db.prepare("INSERT INTO bridges_discord_sessions VALUES ('old','private cursor')").run();
 expect(()=>importBridges(db,f.sources,f.options,h,f.open)).toThrow('must be empty');
 }finally{close();}
});

it('requires local bot mappings, permits explicit remote mappings and preserves each agent own filters',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',extra:{only:['300']}}],['channels','mark',{bot:'200',extra:{only:['400']}}]]);
 expect(readBridgeImport(f.sources,f.options,h,f.open).expected.venues.map(v=>v.agent)).toEqual(['art']);
 f.options.connections.push({agent:'mark',platform:'discord',workspace:'789',bot:'200',tokenSecret:'mark-discord'});
 const venues=readBridgeImport(f.sources,f.options,h,f.open).expected.venues;
 expect(venues.find(v=>v.agent==='art')?.only).toEqual(['300']);expect(venues.find(v=>v.agent==='mark')?.only).toEqual(['400']);
});
it('resolves additional accepted agents people and moved tombstones even without instance files',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100'}],['channels','mark',{bot:'200'}],['people','mark',{people:{loren:{discord:['456']}}}]]);
 f.options.connections.push({agent:'mark',platform:'discord',workspace:'789',bot:'200',tokenSecret:'mark-discord'});
 expect(readBridgeImport(f.sources,f.options,h,f.open).expected.links.map(l=>l.person)).toEqual(['jonathan','loren']);
 const d=new Database(f.sources.stores[0].path);d.prepare('INSERT INTO docs VALUES (?,?,?,1,?,?)').run('moved','mark','{}','now','owner');d.close();
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow();
});
it('store-only accepted parts cannot certify empty setup or bypass moved checks',()=>{
 const f=fixture();f.sources.files=[];f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100'}],['people','art',{people:{jonathan:{discord:['123']}}}]]);
 expect(()=>readBridgeImport(f.sources,{instances:[],connections:[]},h,f.open)).toThrow();
 const options={instances:[],connections:f.options.connections};expect(readBridgeImport(f.sources,options,h,f.open).expected.links[0].person).toBe('jonathan');
 const d=new Database(f.sources.stores[0].path);d.prepare('INSERT INTO docs VALUES (?,?,?,1,?,?)').run('moved','art','{}','now','owner');d.close();
 expect(()=>readBridgeImport(f.sources,options,h,f.open)).toThrow();
});
it('shuttle people override stale files when Runtime gates are absent',()=>{
 const f=fixture();f.store('shuttle',[['people','art',{people:{loren:{discord:['456']}}}]]);
 expect(readBridgeImport(f.sources,f.options,h,f.open).expected.links.map(l=>[l.person,l.user])).toEqual([['loren','456']]);
});
it('refuses contradictory agent account claims against routes and other selected people',()=>{
 const f=fixture();f.store('shuttle',[['people','art',{agents:{art:{discord:['999']}}}]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow();
 const d=new Database(f.sources.stores[0].path);d.prepare('UPDATE docs SET doc=?').run(JSON.stringify({agents:{art:{discord:['100']}}}));d.close();
 expect(readBridgeImport(f.sources,f.options,h,f.open).expected.venues[0].bot).toBe('100');
 const changed=new Database(f.sources.stores[0].path);changed.prepare('UPDATE docs SET doc=?').run(JSON.stringify({agents:{mark:{slack:{T1:['B1']}}}}));
 changed.prepare('INSERT INTO docs VALUES (?,?,?,1,?,?)').run('people','mark',JSON.stringify({agents:{mark:{slack:{T1:['B2']}}}}),'now','owner');changed.close();
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow();
});

it('refuses noncanonical selected store numbers without treating envelope timestamps as IDs',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789',peer_turns_each:1.5}],['channels','art',{bot:'100'}]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow();
});

it('store-only noncanonical bot numbers cannot disappear through a falsy marker',()=>{
 const f=fixture();f.sources.files=[];f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:1.5}]]);
 expect(()=>readBridgeImport(f.sources,{instances:[],connections:[]},h,f.open)).toThrow();
});

it('permits only explicitly incomplete Slack setup from the named source workspace without invented secret names',()=>{
 const f=fixture();writeFileSync(f.sources.files[0].path,JSON.stringify({agent:{slug:'art'},slack:{secrets_env:'slack-onterris.env',workspaces:{TWORK:'Work'}}}));writeFileSync(f.sources.files[2].path,'{}');
 const incomplete={agent:'art',platform:'slack',workspace:'TWORK',setupIncomplete:true};
 const options={...f.options,connections:[incomplete]};
 const source=readBridgeImport(f.sources,options,h,f.open);
 expect(source.expected.venues).toEqual([]);
 expect(JSON.parse(source.evidence).incomplete).toEqual([expect.objectContaining({workspace:'TWORK',bundle:'slack-onterris.env'})]);
 for(const patch of [{platform:'discord'},{workspace:'TOTHER'},{bot:'U1'},{tokenSecret:'invented'},{appSecret:'invented'},{setupIncomplete:undefined}])expect(()=>readBridgeImport(f.sources,{...options,connections:[{...incomplete,...patch}]},h,f.open)).toThrow();
});

it('refuses known/unknown person collisions before filtering household membership',()=>{
 const f=fixture();writeFileSync(f.sources.files[1].path,JSON.stringify({people:{jonathan:{discord:['123']},guest:{discord:['123']}}}));
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow();
});
it('retains Slack identities outside reviewed complete or incomplete workspaces',()=>{
 const f=fixture();writeFileSync(f.sources.files[1].path,JSON.stringify({people:{jonathan:{discord:['123'],slack:{TOTHER:['U1']}}}}));
 const source=readBridgeImport(f.sources,f.options,h,f.open);
 expect(source.expected.links.map(l=>l.platform)).toEqual(['discord']);
 expect(JSON.parse(source.evidence).retained).toContainEqual(expect.objectContaining({kind:'person',owner:'jonathan',reason:'no projectable workspace'}));
});
it('an unprojectable route claim cannot be shadowed by another source or a thread',()=>{
 const f=fixture();
 // A second local instance supplies a less restricted copy of the same channel.
 const extra=(kind:'shuttle'|'people'|'routes',doc:unknown)=>{const name=`mark/${kind}.json`,path=join(f.root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(doc));f.sources.files.push({name,path,kind});return name;};
 const instance={shuttle:extra('shuttle',{agent:{slug:'mark'}}),people:extra('people',{}),routes:extra('routes',{guild:'789',bots:{mark:'200'},channels:{'300':{primary:'art'}},threads:{'500':{parent:'300',primary:'art'}}})};
 writeFileSync(f.sources.files[2].path,JSON.stringify({guild:'789',bots:{art:'100'},channels:{'300':{primary:'art',readers:['guest']}}}));
 const options={instances:[...f.options.instances,instance],connections:[...f.options.connections,{agent:'mark',platform:'discord',workspace:'789',bot:'200',tokenSecret:'mark-discord'}]};
 const source=readBridgeImport(f.sources,options,h,f.open);
 expect(source.expected.routes).toEqual([]);
 for(const venue of source.expected.venues){
  expect(venue.ignore).toContain('300');
  for(const message of [{channel:'300'},{channel:'500',parent:'300'}])expect(addressed({...venue,enabled:true},{...message,id:'message',user:'123',dm:false,text:'hello',mentions:[venue.bot]},undefined,source.expected.venues)).toBe(false);
 }
 expect(JSON.parse(source.evidence).retained).toContainEqual(expect.objectContaining({kind:'route',channel:'500'}));
});

it('checks unknown-agent claims against all selected route bot identities before retaining them',()=>{
 const f=fixture();writeFileSync(f.sources.files[2].path,JSON.stringify({guild:'789',bots:{art:'100',fez:'250'}}));
 writeFileSync(f.sources.files[1].path,JSON.stringify({agents:{fez:{discord:['100']}}}));
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow();
 writeFileSync(f.sources.files[1].path,JSON.stringify({agents:{fez:{discord:['250']}}}));
 expect(readBridgeImport(f.sources,f.options,h,f.open).expected.venues.map(v=>v.agent)).toEqual(['art']);
 writeFileSync(f.sources.files[1].path,'{}');writeFileSync(f.sources.files[2].path,JSON.stringify({guild:'789',bots:{art:'100',fez:'100'}}));
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow();
});

it('preserves safe source file and field diagnostics through the owning import projection',()=>{
 const f=fixture();writeFileSync(f.sources.files[1].path,JSON.stringify({agents:{art:'PRIVATE_ACCOUNT_VALUE'}}));
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow(/^Invalid offline Bridges configuration inventory: people.json at \$\["agents"\]\["art"\]$/);
});
it('skips annotations in accepted store assembly without changing exact private evidence',()=>{
 const f=fixture();const note='PRIVATE_STORE_ANNOTATION';
 f.store('shuttle',[['routes','household',{_note:note,guild:'789',channel_names:{_note:note,'300':'work'},webhook_peers:{_comment:'x'.repeat(395)}}],['channels','art',{_note:note,bot:'100',answers:{_note:note,'300':'work'},flags:{_note:note},threads:{_note:note},extra:{_note:note,ignore:{_note:note,'500':true}}}],['route-offers','art',{doc:{bots:{_note:note,art:'100'},channels:{_note:note,'300':{primary:'art'}}}}]]);
 const store=new Database(f.sources.stores[0].path);
 store.prepare("UPDATE docs SET doc=? WHERE collection='channels'").run(' { "bot":"100", "answers":{"300":"work"}, "_note":"PRIVATE_STORE_ANNOTATION", "extra":{"ignore":{"500":true}}, "ignored_numeric":1.2500 } ');
 const originals=store.prepare('SELECT doc FROM docs ORDER BY collection,key').all() as {doc:string}[];store.close();
 const s=readBridgeImport(f.sources,f.options,h,f.open);
 expect(s.expected.routes.map(r=>r.channel)).toEqual(['300']);
 expect(s.expected.venues[0].ignore).toEqual(['500']);
 expect(JSON.stringify(s.expected)).not.toContain(note);
 const evidence=JSON.parse(s.evidence).stores.stores[0].documents as {doc:string}[];
 expect(evidence.map(d=>d.doc)).toEqual(originals.map(d=>d.doc));
});

it('identifies malformed selected accepted-store maps without values',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',answers:42}]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow('Invalid offline Bridges configuration inventory: shuttle.db at $["channels"]["art"]["answers"]');
});
it('identifies selected Runtime source fields without pretending they came from people.json',()=>{
 const f=fixture();f.store('runtime',[['gates','art',{people:{jonathan:{discord:true}}}]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow('Invalid offline Bridges configuration inventory: runtime.db at $["gates"]["art"]["people"]["jonathan"]["discord"]');
});

for(const [label,household,part,path] of [
 ['bot',{guild:'789'},{bot:false},'["channels"]["art"]["bot"]'],
 ['roles',{guild:'789'},{bot:'100',bot_role:[true]},'["channels"]["art"]["bot_role"]'],
 ['channel name',{guild:'789',channel_names:{'300':false}},{bot:'100'},'["routes"]["household"]["channel_names"]["300"]'],
 ['thread',{guild:'789'},{bot:'100',threads:{'400':{parent:false}}},'["channels"]["art"]["threads"]["400"]["parent"]'],
 ['flag',{guild:'789'},{bot:'100',answers:{'300':'work'},flags:{'300':{peer:'PRIVATE_VALUE'}}},'["channels"]["art"]["flags"]["300"]["peer"]'],
 ['extra',{guild:'789'},{bot:'100',extra:{notify:{general:false}}},'["channels"]["art"]["extra"]["notify"]["general"]'],
] as const)it(`identifies the original accepted-store ${label} field`,()=>{
 const f=fixture();f.store('shuttle',[['routes','household',household],['channels','art',part]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow(`Invalid offline Bridges configuration inventory: shuttle.db at $${path}`);
});

for(const kind of ['runtime','shuttle'] as const)it(`reports malformed ${kind} store JSON safely through the owning projection`,()=>{
 const f=fixture();f.store(kind,[[kind==='runtime'?'gates':'people','art',{}]]);
 const store=new Database(f.sources.stores[0].path);store.prepare('UPDATE docs SET doc=?').run('PRIVATE_BAD_JSON');store.close();
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow(`Invalid offline Bridges configuration inventory: ${kind}.db at $["docs"]["${kind==='runtime'?'gates':'people'}"]["art"]["doc"]`);
});
it('reports malformed revision JSON without original words and still closes the source',()=>{
 const f=fixture();f.store('runtime',[['gates','art',{}]]);
 const store=new Database(f.sources.stores[0].path);store.prepare('INSERT INTO revisions VALUES (1,?,?,?,?,?,?,?)').run('gates','art','PRIVATE_BAD_JSON',1,'put','today','owner');store.close();
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow('Invalid offline Bridges configuration inventory: runtime.db at $["revisions"]["1"]["doc"]');
 const reopened=f.open(f.sources.stores[0].path);expect(reopened.open).toBe(true);reopened.close();
});

it('refuses only contradictory present flags with store, collection, agent and field diagnostics',()=>{
 const f=fixture();f.store('shuttle',[
 ['routes','household',{guild:'789'}],
 ['channels','art',{bot:'100',flags:{'300':{peer:true}}}],
 ['channels','mark',{bot:'200',flags:{'300':{peer:false}}}],
 ]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow('shuttle.db at $["channels"]["mark"]["flags"]["300"]["peer"]');
});
it('validates a malformed present flag even when another part is silent',()=>{
 const f=fixture();f.store('shuttle',[
 ['routes','household',{guild:'789'}],['channels','art',{bot:'100',flags:{'300':{peer:'PRIVATE'}}}],['channels','mark',{bot:'200'}],
 ]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow('shuttle.db at $["channels"]["art"]["flags"]["300"]["peer"]');
});

for(const flags of [null,[],false,'PRIVATE'])it(`rejects a present malformed flags map (${JSON.stringify(flags)})`,()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',flags}],['channels','mark',{bot:'200'}]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow('shuttle.db at $["channels"]["art"]["flags"]');
});
for(const pair of [1.5,9007199254740992])it(`rejects malformed numeric pair before serializing (${pair})`,()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',flags:{'300':{pair}}}],['channels','mark',{bot:'200'}]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow('shuttle.db at $["channels"]["art"]["flags"]["300"]["pair"]');
});
it('keeps explicit default-only sparse flags runnable and blocks descendant mention fallback for non-default partial flags',()=>{
 const f=fixture();f.store('shuttle',[
 ['routes','household',{guild:'789'}],
 ['channels','art',{bot:'100',answers:{'300':'work','400':'default'},flags:{'300':{peer:true},'400':{peer:false,pair:null,guest_venue:false,readers:[]}},threads:{'500':{parent:'300',primary:'art'}}}],
 ['channels','mark',{bot:'200'}],
 ]);
 const result=readBridgeImport(f.sources,f.options,h,f.open);
 expect(result.expected.routes.map(r=>r.channel)).toEqual(['400']);
 const venue={...result.expected.venues[0],enabled:true};
 for(const channel of ['300','500'])expect(addressed(venue,{id:'1',channel,...(channel==='500'?{parent:'300'}:{}),user:'123',text:'hello',mentions:['100'],bot:false,at:'2026-01-01T00:00:00.000Z'},undefined,[venue])).toBe(false);
 expect(JSON.parse(result.evidence).retained.filter((r:{path?:string[]})=>r.path?.includes('400'))).toEqual([]);
});

for(const field of ['name','primary','parent'])it(`validates recognized ${field} before sparse entry serialization`,()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',flags:{'300':{[field]:1.5}}}],['channels','mark',{bot:'200'}]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow(`shuttle.db at $["channels"]["art"]["flags"]["300"]["${field}"]`);
});

for(const [field,value]of [['peer','PRIVATE'],['pair',1.5],['guest_venue','PRIVATE'],['readers',false]] as const)it(`validates inherited thread ${field} before discarding it`,()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',answers:{'300':'work'},threads:{'500':{parent:'300',primary:'art',[field]:value}}}]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow(`shuttle.db at $["channels"]["art"]["threads"]["500"]["${field}"]`);
});
it('sparse import blocks supplied default and peer routes for enabled channels and threads',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',answers:{'300':'work'},flags:{'300':{peer:true}},threads:{'500':{parent:'300',primary:'art'}}}],['channels','mark',{bot:'200'}]]);
 const result=readBridgeImport(f.sources,f.options,h,f.open),venue={...result.expected.venues[0],enabled:true};
 const peer={...venue,id:'peer',agent:'mark',bot:'200'};
 for(const channel of ['300','500']){
  const route={id:'test',platform:'discord' as const,workspace:'789',channel,primary:'art',peer:true,guest:false,readers:[],notes:[]};
  const message={id:'1',channel,...(channel==='500'?{parent:'300'}:{}),user:'123',text:'hello',mentions:[],bot:false,at:'2026-01-01T00:00:00.000Z'};
  expect(addressed(venue,message,route,[venue,peer])).toBe(false);
  expect(addressed(venue,{...message,user:'200',bot:true,mentions:['100']},route,[venue,peer])).toBe(false);
 }
});

it('keeps accepted zero budget evidence and checksum exact across interrupted and repeated import',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789',peer_turns_each:0}],['channels','art',{bot:'100'}]]);
 const before=readBridgeImport(f.sources,f.options,h,f.open),{db,close}=openDb(join(f.root,'new'));
 try{
  expect(()=>importBridges(db,f.sources,f.options,h,f.open,{interrupt:()=>{throw Error('interrupted zero');}})).toThrow('interrupted zero');
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridges_meta'").get()).toBeUndefined();
  expect(importBridges(db,f.sources,f.options,h,f.open)).toMatchObject({imported:true,checksum:before.checksum});
  expect(importBridges(db,f.sources,f.options,h,f.open)).toMatchObject({imported:false,checksum:before.checksum});
  expect((db.prepare("SELECT value FROM bridges_meta WHERE key='legacy-evidence'").get() as {value:string}).value).toBe(before.evidence);
  const source=new Database(f.sources.stores[0].path);
  try{
   const raw=(source.prepare("SELECT doc FROM docs WHERE collection='routes'").get() as {doc:string}).doc;
   expect(raw).toBe('{"guild":"789","peer_turns_each":0}');
   source.prepare("UPDATE docs SET doc=? WHERE collection='routes'").run('{"guild":"789","peer_turns_each":null}');
  }finally{source.close();}
  expect(readBridgeImport(f.sources,f.options,h,f.open).checksum).not.toBe(before.checksum);
  expect(()=>importBridges(db,f.sources,f.options,h,f.open)).toThrow('different Bridges source');
 }finally{close();}
});
it('refuses invalid accepted-store peer budgets at their original source path',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100'}]]);
 for(const spelling of ['-1','-0','0.5','9007199254740993','9007199254740991.1','0.0','0e0','"0"','true']){
  const d=new Database(f.sources.stores[0].path);
  try{d.prepare("UPDATE docs SET doc=? WHERE collection='routes'").run(`{"guild":"789","peer_turns_each":${spelling}}`);}finally{d.close();}
  expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow('shuttle.db at $["routes"]["household"]["peer_turns_each"]');
 }
});

it('keeps selected accepted note maps scoped to their source agent without proposal or stale file fallback',()=>{
 const f=fixture();
 writeFileSync(f.sources.files[2].path,JSON.stringify({guild:'789',bots:{art:'100'},stale:['300']}));
 f.store('shuttle',[['routes','household',{guild:'789'}],
 ['channels','art',{bot:'100',answers:{'300':'work'},extra:{'custom / key':['300'],mapped:{'400':1.25,'600':'PRIVATE_UNUSED_MAP_VALUE'},float:1.25,scalar:300,scalarString:'300'}}],
 ['channels','mark',{bot:'200',extra:{'custom / key':['400']}}],
 ['route-offers','art',{doc:{bots:{art:'100',mark:'200'},proposal:['999']}}]]);
 const result=readBridgeImport(f.sources,f.options,h,f.open);
 expect(JSON.parse(result.evidence).noteInventories).toEqual([
  {source:'accepted:art',agent:'art',noteChannels:{'custom / key':['300'],mapped:['400','600'],scalar:['300'],scalarString:['300']}},
  {source:'accepted:mark',agent:'mark',noteChannels:{'custom / key':['400']}}]);
 expect(result.expected.routes.every(r=>r.notes.length===0)).toBe(true);
 expect(JSON.stringify(JSON.parse(result.evidence).noteInventories)).not.toContain('PRIVATE_UNUSED_MAP_VALUE');
 const original=JSON.parse(result.evidence).stores.stores[0].documents.find((d:{collection:string;key:string})=>d.collection==='channels'&&d.key==='art').doc;
 expect(JSON.parse(original).extra.mapped['600']).toBe('PRIVATE_UNUSED_MAP_VALUE');
 const {db,close}=openDb(join(f.root,'new'));
 try{
  expect(()=>importBridges(db,f.sources,f.options,h,f.open,{interrupt:()=>{throw Error('note interruption');}})).toThrow('note interruption');
  expect(importBridges(db,f.sources,f.options,h,f.open).imported).toBe(true);
  expect(importBridges(db,f.sources,f.options,h,f.open).imported).toBe(false);
  expect((db.prepare("SELECT value FROM bridges_meta WHERE key='legacy-evidence'").get() as {value:string}).value).toBe(result.evidence);
 }finally{close();}
});

it('refuses unsafe accepted note members at the original extra path while ignoring numeric map values',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',extra:{mapped:{'300':1.25}}}]]);
 expect(JSON.parse(readBridgeImport(f.sources,f.options,h,f.open).evidence).noteInventories[0].noteChannels).toEqual({mapped:['300']});
 const d=new Database(f.sources.stores[0].path);
 try{d.prepare("UPDATE docs SET doc=? WHERE collection='channels'").run('{"bot":"100","extra":{"arbitrary":[9007199254740993]}}');}finally{d.close();}
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow('shuttle.db at $["channels"]["art"]["extra"]["arbitrary"]["0"]');
});

it('binds selected document bytes to an effective agent note key and import checksum',()=>{
 const f=fixture();writeFileSync(f.sources.files[2].path,JSON.stringify({guild:'789',bots:{art:'100'},work:['300']}));
 const path=join(f.root,'selected.md');writeFileSync(path,'PRIVATE SELECTED\r\n');
 f.sources.documents=[{name:'bridges-documents/0.md',path}];
 const options={...f.options,documents:[{path:'bridges-documents/0.md',agent:'art',key:'work'}]};
 const before=readBridgeImport(f.sources,options,h,f.open),{db,close}=openDb(join(f.root,'new'));
 try{
  expect(()=>importBridges(db,f.sources,options,h,f.open,{interrupt:()=>{throw Error('interrupted document');}})).toThrow('interrupted document');
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridges_meta'").get()).toBeUndefined();
  expect(importBridges(db,f.sources,options,h,f.open).imported).toBe(true);
  expect(importBridges(db,f.sources,options,h,f.open).imported).toBe(false);
  expect((db.prepare("SELECT value FROM bridges_meta WHERE key='legacy-evidence'").get() as{value:string}).value).toBe(before.evidence);
  writeFileSync(path,'changed');expect(readBridgeImport(f.sources,options,h,f.open).checksum).not.toBe(before.checksum);
  expect(()=>importBridges(db,f.sources,options,h,f.open)).toThrow('different Bridges source');
  for(const documents of [[],[{path:'bridges-documents/1.md',agent:'art',key:'work'}],[{path:'bridges-documents/0.md',agent:'mark',key:'work'}],[{path:'bridges-documents/0.md',agent:'art',key:'missing'}]])expect(()=>readBridgeImport(f.sources,{...options,documents},h,f.open)).toThrow('Invalid offline');
  expect(()=>readBridgeImport({...f.sources,documents:[]},options,h,f.open)).toThrow('Invalid offline');
 }finally{close();}
});

it('refuses repeated document imports after persisted evidence is changed or deleted',()=>{
 const f=fixture();writeFileSync(f.sources.files[2].path,JSON.stringify({guild:'789',bots:{art:'100'},work:['300']}));
 const path=join(f.root,'selected.md');writeFileSync(path,'PRIVATE SELECTED');f.sources.documents=[{name:'bridges-documents/0.md',path}];
 const options={...f.options,documents:[{path:'bridges-documents/0.md',agent:'art',key:'work'}]};
 const {db,close}=openDb(join(f.root,'new'));try{
  importBridges(db,f.sources,options,h,f.open);
  const original=(db.prepare("SELECT value FROM bridges_meta WHERE key='legacy-evidence'").get() as{value:string}).value;
  const corrupted=JSON.parse(original);corrupted.selectedDocuments[0].content='changed';
  db.prepare("UPDATE bridges_meta SET value=? WHERE key='legacy-evidence'").run(JSON.stringify(corrupted));
  expect(()=>importBridges(db,f.sources,options,h,f.open)).toThrow('comparison failed');
  db.prepare("DELETE FROM bridges_meta WHERE key='legacy-evidence'").run();
  expect(()=>importBridges(db,f.sources,options,h,f.open)).toThrow('comparison failed');
  db.prepare("INSERT INTO bridges_meta VALUES ('legacy-evidence',?)").run(original);
  expect(importBridges(db,f.sources,options,h,f.open).imported).toBe(false);
 }finally{close();}
});

it('refuses document attribution to a non-household accepted route owner even with a matching note key',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',extra:{work:['300']}}],['channels','fez',{extra:{work:['300']}}]]);
 expect(JSON.parse(readBridgeImport(f.sources,f.options,h,f.open).evidence).noteInventories).toContainEqual({source:'accepted:fez',agent:'fez',noteChannels:{work:['300']}});
 const path=join(f.root,'selected.md');writeFileSync(path,'PRIVATE');f.sources.documents=[{name:'bridges-documents/0.md',path}];
 expect(()=>readBridgeImport(f.sources,{...f.options,documents:[{path:'bridges-documents/0.md',agent:'fez',key:'work'}]},h,f.open)).toThrow('Invalid offline');
});

it.each(['','x'.repeat(201)])('preserves source note-key vocabulary in selected document attribution (%j)',key=>{
 const f=fixture();writeFileSync(f.sources.files[2].path,JSON.stringify({guild:'789',bots:{art:'100'},[key]:['300']}));
 const path=join(f.root,'selected.md');writeFileSync(path,'PRIVATE exact context');f.sources.documents=[{name:'bridges-documents/0.md',path}];
 const options={...f.options,documents:[{path:'bridges-documents/0.md',agent:'art',key}]};
 expect(JSON.parse(readBridgeImport(f.sources,options,h,f.open).evidence).selectedDocuments[0]).toMatchObject({agent:'art',key,content:'PRIVATE exact context'});
 const {db,close}=openDb(join(f.root,'new'));try{
  expect(importBridges(db,f.sources,options,h,f.open).imported).toBe(true);
  expect(importBridges(db,f.sources,options,h,f.open).imported).toBe(false);
 }finally{close();}
});

it('resolves every configured brief against effective accepted membership, preserving file order and exact bytes',async()=>{
 const {selectChannelBriefs}=await import('./import-briefs.js');
 const f=fixture();
 writeFileSync(f.sources.files[0].path,'{"agent":{"slug":"art"},"discord":{"token_file":"not-read"},"channel_notes":{"10":"ten","2":"two","z":"same","a":"same"}}');
 // File membership is stale: accepted per-agent extras are authoritative.
 writeFileSync(f.sources.files[2].path,JSON.stringify({guild:'789',bots:{art:'100'},'10':['wrong']}));
 f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',answers:{'300':'work'},threads:{'500':{parent:'300'}},extra:{'10':['300'],'2':['500'],z:['300','500'],a:[]}}]]);
 const keys=['10','2','z','a'];const content='\ufeffPRIVATE $text\r\nUnicode 🐟';
 f.sources.documents=keys.map((key,i)=>{const path=join(f.root,`${i}.md`);writeFileSync(path,content+key);return {name:`bridges-documents/${i}.md`,path};});
 const documents=keys.map((key,i)=>({path:`bridges-documents/${i}.md`,agent:'art',key,brief:i<2?i===0?'ten':'two':'same'}));
 const options={...f.options,documents:documents.toReversed()};
 const result=readBridgeImport(f.sources,options,h,f.open),evidence=JSON.parse(result.evidence);
 const resolved=evidence.configuredBriefs[0];
 expect(resolved).toMatchObject({agent:'art',source:'instance/shuttle.json',routeSource:'accepted:art'});
 expect(resolved.briefs.map((b:{key:string})=>b.key)).toEqual(keys);
 expect(selectChannelBriefs(resolved.briefs,'500','300').map(b=>b.key)).toEqual(['10','2','z']);
 expect(selectChannelBriefs(resolved.briefs,'500','unknown').map(b=>b.key)).toEqual(['2','z']);
 expect(evidence.selectedDocuments.find((d:{key:string})=>d.key==='10').content).toBe(content+'10');
 expect(result.expected.routes.every(r=>r.notes.length===0)).toBe(true);
 const {db,close}=openDb(join(f.root,'new'));try{
  expect(()=>importBridges(db,f.sources,options,h,f.open,{interrupt:()=>{throw Error('interrupt resolved');}})).toThrow('interrupt resolved');
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridges_meta'").get()).toBeUndefined();
  expect(importBridges(db,f.sources,options,h,f.open).imported).toBe(true);
  expect(importBridges(db,f.sources,options,h,f.open).imported).toBe(false);
  const corrupted=JSON.parse(result.evidence);corrupted.configuredBriefs[0].briefs.reverse();
  db.prepare("UPDATE bridges_meta SET value=? WHERE key='legacy-evidence'").run(JSON.stringify(corrupted));
  expect(()=>importBridges(db,f.sources,options,h,f.open)).toThrow('comparison failed');
 }finally{close();}
});

it('refuses unresolved, wrong-name, ambiguous, wrong-agent and stale-source configured brief mappings even for empty membership',()=>{
 const f=fixture();writeFileSync(f.sources.files[0].path,JSON.stringify({agent:{slug:'art'},discord:{token_file:'not-read'},channel_notes:{work:'required'}}));
 writeFileSync(f.sources.files[2].path,JSON.stringify({guild:'789',bots:{art:'100'},work:[]}));
 const path=join(f.root,'doc.md');writeFileSync(path,'PRIVATE');f.sources.documents=[{name:'bridges-documents/0.md',path}];
 const document={path:'bridges-documents/0.md',agent:'art',key:'work',brief:'required'};
 for(const documents of [[],[{...document,brief:undefined}],[{...document,brief:'wrong'}],[{...document,agent:'mark'}]])expect(()=>readBridgeImport(f.sources,{...f.options,documents},h,f.open)).toThrow('Invalid offline');
 expect(readBridgeImport(f.sources,{...f.options,documents:[document]},h,f.open)).toBeDefined();
 const second=join(f.root,'second.md');writeFileSync(second,'other');f.sources.documents.push({name:'bridges-documents/1.md',path:second});
 expect(()=>readBridgeImport(f.sources,{...f.options,documents:[document,{...document,path:'bridges-documents/1.md'}]},h,f.open)).toThrow('Invalid offline');
 f.sources.documents.pop();
 f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',extra:{other:[]}}]]);
 expect(()=>readBridgeImport(f.sources,{...f.options,documents:[document]},h,f.open)).toThrow('Invalid offline');
});

it.each(['','x'.repeat(201)])('resolves literal configured keys and brief names without path or slug normalization (%j)',key=>{
 const f=fixture(),brief=key;
 writeFileSync(f.sources.files[0].path,JSON.stringify({agent:{slug:'art'},discord:{token_file:'never'},channel_notes:{[key]:brief}}));
 writeFileSync(f.sources.files[2].path,JSON.stringify({guild:'789',bots:{art:'100'},[key]:[]}));
 const path=join(f.root,'literal.md');writeFileSync(path,'EXACT');f.sources.documents=[{name:'bridges-documents/0.md',path}];
 const options={...f.options,documents:[{path:'bridges-documents/0.md',agent:'art',key,brief}]};
 expect(JSON.parse(readBridgeImport(f.sources,options,h,f.open).evidence).configuredBriefs[0].briefs).toEqual([{key,brief,path:'bridges-documents/0.md',sha256:expect.any(String),channels:[]}]);
});

it('captures a complete selected template family privately without a route-note membership or runtime setup',async()=>{
 const {default:families}=await import('./__fixtures__/template-families.json',{with:{type:'json'}});
 const f=fixture(),briefs:Record<string,string>={};
 f.sources.documents=Object.entries(families.discord).map(([brief,content],i)=>{
  const path=join(f.root,`${i}.md`),name=`bridges-documents/${i}.md`;writeFileSync(path,brief==='discord'?content+' $new $where':content);briefs[brief]=name;return {name,path};
 });
 const family={shuttle:'instance/shuttle.json',platform:'discord' as const,briefs},options={...f.options,templateFamilies:[family]};
 const result=readBridgeImport(f.sources,options,h,f.open),evidence=JSON.parse(result.evidence);
 expect(evidence.templateFamilies).toEqual([{source:family.shuttle,agent:'art',platform:'discord',briefs:Object.entries(families.discord).map(([brief,content])=>({brief,path:briefs[brief],sha256:expect.stringMatching(/^[a-f0-9]{64}$/),bytes:Buffer.byteLength(brief==='discord'?content+' $new $where':content),content:brief==='discord'?content+' $new $where':content,references:expect.any(Array)}))}]);
 expect(evidence.templateFamilies[0].briefs[0].references).toEqual(['where','chan_id','chan_name','notes','new','context','send','owner_line']);
 expect(result.expected.routes[0].notes).toEqual([]);expect(result.expected.venues[0].enabled).toBe(false);
 expect(evidence.selectedDocuments).toBeUndefined();
 for(const templateFamilies of [[{...family,shuttle:'unknown'}],[family,family],[{...family,platform:'slack'}],[{...family,briefs:{...briefs,unknown:briefs.discord}}],[{...family,briefs:{...briefs,'discord-pair':briefs.discord}}]])expect(()=>readBridgeImport(f.sources,{...options,templateFamilies},h,f.open)).toThrow('Invalid offline');
 // Keep every other acceptance condition valid when checking family names.
 const {['discord-pair']:pair,...renamed}=briefs;
 expect(()=>readBridgeImport(f.sources,{...options,templateFamilies:[{...family,briefs:{...renamed,unknown:pair}}]},h,f.open)).toThrow('Invalid offline');
 const originalDocuments=f.sources.documents;
 f.sources.documents=originalDocuments.filter(d=>d.name!==briefs['discord-pair']);
 expect(()=>readBridgeImport(f.sources,{...options,templateFamilies:[{...family,briefs:renamed}]},h,f.open)).toThrow('Invalid offline');
 f.sources.documents=originalDocuments;
 const copiedBriefs:Record<string,string>={};
 const copies=Object.entries(families.discord).map(([brief,content],i)=>{
  const path=join(f.root,`copy-${i}.md`),name=`bridges-documents/${i+8}.md`;writeFileSync(path,content);copiedBriefs[brief]=name;return {name,path};
 });
 f.sources.documents=[...originalDocuments,...copies];
 expect(()=>readBridgeImport(f.sources,{...options,templateFamilies:[family,{...family,briefs:copiedBriefs}]},h,f.open)).toThrow('Invalid offline');
 f.sources.documents=originalDocuments;
 // The mixed positive control is valid; only cross-kind path uniqueness changes.
 writeFileSync(f.sources.files[2].path,JSON.stringify({guild:'789',bots:{art:'100'},channels:{'300':{primary:'art'}},work:['300']}));
 const notePath=join(f.root,'note.md');writeFileSync(notePath,'Independent selected note');
 f.sources.documents=[...originalDocuments,{name:'bridges-documents/20.md',path:notePath}];
 const mixed={...options,documents:[{path:'bridges-documents/20.md',agent:'art',key:'work'}]};
 expect(readBridgeImport(f.sources,mixed,h,f.open)).toBeDefined();
 expect(()=>readBridgeImport(f.sources,{...mixed,documents:[{...mixed.documents[0],path:briefs.discord}]},h,f.open)).toThrow('Invalid offline');
 f.sources.documents=originalDocuments;
 const {['discord-guest']:_,...missing}=briefs;
 expect(()=>readBridgeImport(f.sources,{...options,templateFamilies:[{...family,briefs:missing}]},h,f.open)).toThrow('Invalid offline');
 writeFileSync(f.sources.documents[0].path,'$notes $unknown');expect(()=>readBridgeImport(f.sources,options,h,f.open)).toThrow('Invalid offline');
 writeFileSync(f.sources.documents[0].path,families.discord.discord+' $new $where');
 const {db,close}=openDb(join(f.root,'new'));try{
  expect(()=>importBridges(db,f.sources,options,h,f.open,{interrupt:()=>{throw Error('interrupted');}})).toThrow('interrupted');
  expect(importBridges(db,f.sources,options,h,f.open).imported).toBe(true);expect(importBridges(db,f.sources,options,h,f.open).imported).toBe(false);
  const saved=JSON.parse((db.prepare("SELECT value FROM bridges_meta WHERE key='legacy-evidence'").get() as {value:string}).value);
  saved.templateFamilies[0].briefs[0].content='tampered';db.prepare("UPDATE bridges_meta SET value=? WHERE key='legacy-evidence'").run(JSON.stringify(saved));
  expect(()=>importBridges(db,f.sources,options,h,f.open)).toThrow('content differ');
 }finally{close();}
});

// Keep this control's capture local so it stays independent of the mixed-family fixture.
it('requires a mapped platform even for a complete otherwise valid selected Slack family',async()=>{
 const {default:families}=await import('./__fixtures__/template-families.json',{with:{type:'json'}});
 const f=fixture(),briefs:Record<string,string>={};
 f.sources.documents=Object.entries(families.slack).map(([brief,content],i)=>{
  const path=join(f.root,`${i}.md`),name=`bridges-documents/${i}.md`;writeFileSync(path,content);briefs[brief]=name;return {name,path};
 });
 const options={...f.options,templateFamilies:[{shuttle:'instance/shuttle.json',platform:'slack',briefs}]};
 expect(()=>readBridgeImport(f.sources,options,h,f.open)).toThrow('Invalid offline');
 writeFileSync(f.sources.files[0].path,JSON.stringify({agent:{slug:'art'},discord:{token_file:'never'},slack:{secrets_env:'never-open',workspaces:{TWORK:'work'}}}));
 const connected={...options,connections:[...options.connections,{agent:'art',platform:'slack',workspace:'TWORK',setupIncomplete:true}]};
 const result=readBridgeImport(f.sources,connected,h,f.open);
 expect(JSON.parse(result.evidence).templateFamilies[0]).toMatchObject({agent:'art',platform:'slack',briefs:expect.arrayContaining([expect.objectContaining({brief:'slack-dm',content:families.slack['slack-dm']})])});
});
