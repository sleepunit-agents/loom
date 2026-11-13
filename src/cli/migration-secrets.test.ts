import * as secretsImporter from '../pieces/secrets/importer.js';
import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSnapshotSqlite} from './migration-sqlite.js';
import {Readable} from 'node:stream';
import {createSnapshot} from './migration-snapshot.js';
import {prepareMigrationPlan} from './migration-plan.js';
import {runMigrationAll} from './migration-all.js';
import {verifyMigration} from './migration-verify.js';
import {run} from './migrate.js';
import {createMigrationRegistry} from './migration-registry.js';
import {createFoundation} from '../core/app.js';
import {importHousehold} from './household-importer.js';
import {acquireHttpLock} from '../transport/http-lock.js';
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const d of roots.splice(0))rmSync(d,{recursive:true,force:true});});
const now=Date.parse('2026-11-13T12:00:00.000Z'), at='2026-11-13T11:59:00.000Z';
const pending={id:'q-12345678',secret:'API',agent:'art',house:'h-2',why:'work',minutes:60,at,state:'pending'};
const bytes=(dir:string):unknown=>Object.fromEntries(readdirSync(dir).sort().map(n=>{const p=join(dir,n);try{return[n,readFileSync(p).toString('base64')];}catch{return[n,bytes(p)];}}));
async function setup() {
 const dir=mkdtempSync(join(tmpdir(),'migration-secrets-'));roots.push(dir);
 const old=join(dir,'old'),source=join(old,'secrets'),root=join(dir,'snapshot'),home=join(dir,'new');mkdirSync(source,{recursive:true});
 writeFileSync(join(old,'household.json'),JSON.stringify({v:1,agents:['art'],default:'art',owner:'jonathan'}));
 writeFileSync(join(source,'store.sops.json'),JSON.stringify({API:'ENC[AES256_GCM,data:CANARY_CIPHERTEXT,type:str]',sops:{}}));
 writeFileSync(join(source,'policy.json'),JSON.stringify({v:1,secrets:{API:{houses:['art'],grant:'ask'}}}));
 writeFileSync(join(source,'requests.json'),JSON.stringify({v:1,requests:{[pending.id]:pending}}));
 writeFileSync(join(source,'audit.jsonl'),JSON.stringify({at,event:'set',secret:'API',how:'add'})+'\n');
 await createSnapshot(old,root);return {dir,old,source,root,home,plan:prepareMigrationPlan(root).plan};
}
it('discovers and registers secrets, runs all with managed pending asks, verifies independently without changing either side',async()=>{
 const f=await setup(),before=bytes(f.root);
 expect(f.plan.importers.secrets).toEqual({paths:['home/secrets'],options:{agents:{art:'art'},members:{jonathan:'jonathan'}}});
 expect(createMigrationRegistry().order(['secrets']).importers.map(e=>e.name)).toEqual(['household','secrets']);
 expect((await runMigrationAll(f.root,f.home,undefined,{now:()=>now})).status).toBe('complete');
 const target=bytes(f.home);
 const importer=vi.spyOn(secretsImporter,'importSecrets').mockImplementation(()=>{throw Error('Verifier ran importer');});
 expect(await verifyMigration(f.root,f.home)).toMatchObject({status:'verified',pieces:['household','secrets'],differences:[]});
 expect(bytes(f.root)).toEqual(before);expect(bytes(f.home)).toEqual(target);
 expect(importer).not.toHaveBeenCalled();importer.mockRestore();
 const db=openSnapshotSqlite(join(f.home,'loom.db'));
 try {
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
  expect(JSON.stringify(tables.map(t=>db.prepare(`SELECT * FROM "${t.name}"`).all()))).not.toContain('CANARY_CIPHERTEXT');
 } finally {db.close();}
 expect((await runMigrationAll(f.root,f.home)).pieces.every(p=>p.status==='completed')).toBe(true);expect(bytes(f.home)).toEqual(target);
});
it('independent verification detects physical names/policy/request/grant/use/history/ask tampering despite intact receipts and leaves damaged bytes untouched',async()=>{
 const f=await setup();await runMigrationAll(f.root,f.home,undefined,{now:()=>now});
 const mutations:[string,string][]=[
 ['secrets_names',"UPDATE secrets_names SET record='{}'"],['secrets_meta',"UPDATE secrets_meta SET value='{}' WHERE key='policy'"],
 ['secrets_requests',"UPDATE secrets_requests SET record='{}'"],['attention_asks',"UPDATE attention_asks SET record='{}'"],
 ['secrets_grants',"INSERT INTO secrets_grants VALUES ('extra','art','secret','API','{}')"],
 ['secrets_changes',"UPDATE secrets_changes SET record='{}'"],['secrets_uses',"INSERT INTO secrets_uses VALUES ('extra','API','{}')"],
 ];
 for(const [table,sql] of mutations){
  const db=new Database(join(f.home,'loom.db'));db.exec(sql);db.pragma('wal_checkpoint(TRUNCATE)');db.close();
  const before=bytes(f.home),report=await verifyMigration(f.root,f.home);
  expect(report.status).toBe('different');expect(report.differences.some(d=>d.piece==='secrets'&&d.table===table)).toBe(true);expect(bytes(f.home)).toEqual(before);
 }
});
it('resumes the post-commit crash window with stable source time and refuses omitted/ambiguous inputs',async()=>{
 const f=await setup();
 await expect(runMigrationAll(f.root,f.home,undefined,{now:()=>now,afterPiece:n=>{if(n==='secrets')throw Error('power');}})).rejects.toThrow('power');
 expect((await runMigrationAll(f.root,f.home,undefined,{now:()=>now+999999})).status).toBe('complete');
 expect((await verifyMigration(f.root,f.home)).status).toBe('verified');
 const plan=structuredClone(f.plan);delete plan.importers.secrets;expect(()=>prepareMigrationPlan(f.root,plan)).toThrow('omits discovered secrets');
});
it('CLI imports only explicit metadata into a stopped imported household, with safe errors and lock refusal',async()=>{
 const f=await setup(),io={stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:vi.fn(),stderr:vi.fn()};
 const map=join(f.dir,'map.json');writeFileSync(map,JSON.stringify(f.plan.importers.secrets.options));
 const args=['secrets','--home',f.home,'--from',f.source,'--identities',map];
 expect(await run(['secrets'],io)).toBe(2);
 const app=createFoundation({home:f.home});importHousehold(app.db,f.home,f.old,now);app.close();
 const release=acquireHttpLock(f.home);try{expect(await run(args,io)).toBe(1);expect(io.stderr.mock.calls.at(-1)).toEqual(['Secrets import refused: destination-lock\n']);}finally{release();}
 expect(await run(args,io)).toBe(0);expect(await run(args,io)).toBe(0);
 writeFileSync(map,'SECRET_INPUT_CANARY');expect(await run(args,io)).toBe(1);
 expect(io.stderr.mock.calls.at(-1)).toEqual(['Secrets import refused: identity-options\n']);
 expect(io.stderr.mock.calls.flat().join('')).not.toContain('SECRET_INPUT_CANARY');
});

it('refuses source/destination overlap and symlink aliases before creating lock/database or changing source bytes',async()=>{
 const f=await setup(),io={stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:vi.fn(),stderr:vi.fn()};
 const map=join(f.dir,'map.json');writeFileSync(map,JSON.stringify(f.plan.importers.secrets.options));
 const before=bytes(f.old);
 const alias=join(f.dir,'alias');symlinkSync(f.source,alias);
 for(const home of [f.source,join(f.source,'child'),f.old,alias,join(alias,'child')]){
  expect(await run(['secrets','--home',home,'--from',f.source,'--identities',map],io)).toBe(1);
  expect(io.stderr.mock.calls.at(-1)).toEqual(['Secrets import refused: destination-paths\n']);
  expect(bytes(f.old)).toEqual(before);
 }
});

it('rejects hardlinked source inputs before SQLite can chmod their destination alias',async()=>{
 const f=await setup(),io={stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:vi.fn(),stderr:vi.fn()};
 const map=join(f.dir,'map.json');writeFileSync(map,JSON.stringify(f.plan.importers.secrets.options));
 mkdirSync(f.home);const input=join(f.source,'store.sops.json');linkSync(input,join(f.home,'loom.db'));
 const before=statSync(input).mode;
 expect(await run(['secrets','--home',f.home,'--from',f.source,'--identities',map],io)).toBe(1);
 expect(io.stderr.mock.calls).toEqual([['Secrets import refused: copied-source\n']]);
 expect(statSync(input).mode).toBe(before);expect(readdirSync(f.home)).toEqual(['loom.db']);
});

it('standalone and all CLI report only the fixed Secrets check on invalid audit metadata',async()=>{
 const f=await setup(),io={stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:vi.fn(),stderr:vi.fn()};
 const map=join(f.dir,'map.json');writeFileSync(map,JSON.stringify(f.plan.importers.secrets.options));
 writeFileSync(join(f.source,'audit.jsonl'),JSON.stringify({at,event:'always',secret:'API',PRIVATE_FIELD:'PRIVATE_VALUE'}));
 const app=createFoundation({home:f.home});importHousehold(app.db,f.home,f.old,now);app.close();
 expect(await run(['secrets','--home',f.home,'--from',f.source,'--identities',map],io)).toBe(1);
 expect(io.stderr.mock.calls).toEqual([['Secrets import refused: audit-schema\n']]);
 const snapshot=join(f.dir,'invalid-snapshot');await createSnapshot(f.old,snapshot);
 io.stderr.mockClear();
 expect(await run(['all','--snapshot',snapshot,'--home',join(f.dir,'all-home')],io)).toBe(1);
 expect(io.stderr.mock.calls).toEqual([['Secrets import refused: audit-schema\n']]);
});

it('names malformed identity options and missing source checks without echoing paths or keys',async()=>{
 const f=await setup(),io={stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:vi.fn(),stderr:vi.fn()};
 const map=join(f.dir,'map.json');
 const args=['secrets','--home',f.home,'--from',f.source,'--identities',map];
 for(const raw of ['PRIVATE_VALUE',JSON.stringify({PRIVATE_FIELD:'PRIVATE_VALUE'})]){
  writeFileSync(map,raw);io.stderr.mockClear();
  expect(await run(args,io)).toBe(1);expect(io.stderr.mock.calls).toEqual([['Secrets import refused: identity-options\n']]);
 }
 writeFileSync(map,JSON.stringify(f.plan.importers.secrets.options));io.stderr.mockClear();
 expect(await run(['secrets','--home',f.home,'--from',join(f.dir,'PRIVATE_PATH'),'--identities',map],io)).toBe(1);
 expect(io.stderr.mock.calls).toEqual([['Secrets import refused: source-files\n']]);
});
