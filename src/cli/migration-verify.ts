import { fileDigest } from './migration-files.js';
import { compareRuntimeArchive } from '../pieces/runtime/import-archive.js';
/** Offline comparison only. No foundation, migrations, importer calls or writable opens. */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compareComms } from './migration-comms-projection.js';
import { snapshotPath } from './migration-registry.js';
import { expectedTables, readRuntimeProjection, type Row } from './migration-projection.js';
import { readReceipt, separateDestination } from './migration-all.js';
import { canonicalPlanValue, migrationPlanChecksum, prepareMigrationPlan } from './migration-plan.js';
import { openSnapshotSqlite } from './migration-sqlite.js';
import type { IOStreams } from './io.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { SharingDatabase } from '../core/household/sharing.js';
import { parseHouseholdDocument } from '../household.js';
import { runtimeImportTables } from '../pieces/runtime/import-projection.js';
import { assertRuntimeCheckpointed, sameRuntimeHousehold } from './migration-runtime.js';

export interface VerificationDifference { piece: string; table: string; expected: number; actual: number | null }
export interface VerificationReport { status: 'verified' | 'different' | 'incomplete'; snapshot: string; plan: string; pieces: string[]; missing: string[]; differences: VerificationDifference[] }
const optional = (path: string): Buffer | undefined => existsSync(path) ? readFileSync(path) : undefined;
const verifiers = ['household','tasks','attention','clock','approvals','changes','comms','secrets','runtime'];
/** Compare JSON semantically; ordering is retained inside records, table row order is immaterial. */
function normalize(records: Row[]): string {
  return canonicalPlanValue(records.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key, (key==='body'||key==='record') && typeof value==='string' ? JSON.parse(value) : value]))).map(row=>canonicalPlanValue(row)).sort());
}
function compareTable(db:Database.Database,table:string,expected:Row[],filter?:(row:Row)=>boolean):Omit<VerificationDifference,'piece'>|undefined {
  let actual:Row[]|null=null;
  try {
    const columns=table==='approvals_approvals'||table==='approvals_rules'?'rowid AS migration_order, *':'*';
    actual=db.prepare(`SELECT ${columns} FROM ${table}`).all() as Row[];
    if(filter)actual=actual.filter(filter);
  } catch {/* A missing schema or invalid record is a difference. */}
  let equal=false;try{equal=actual!==null&&normalize(actual)===normalize(expected);}catch{/* Corrupt JSON differs. */}
  if(!equal)return {table,expected:expected.length,actual:actual?.length??null};
}
export async function verifyMigration(snapshot: string, destination: string, supplied?: unknown): Promise<VerificationReport> {
  const prepared = prepareMigrationPlan(snapshot,supplied), home = resolve(destination), plan = prepared.plan;
  if (separateDestination(prepared.root,home,plan).length) throw Error('Interrupted key publication');
  const receipt = readReceipt(home,plan); if (!receipt) throw Error('Migration receipt required');
  // BEGIN EXCLUSIVE on an existing read-only rollback-mode lock DB changes no bytes,
  // while excluding both the daemon and all-runner for the whole comparison.
  const lockPath = join(home,'http-daemon-lock.db'), lockBytes = readFileSync(lockPath);
  if (lockBytes.length && (lockBytes.length < 20 || lockBytes[18] !== 1 || lockBytes[19] !== 1)) throw Error('Unsafe daemon gate');
  for (const suffix of ['-wal','-shm','-journal']) if (existsSync(lockPath+suffix)) throw Error('Unsafe daemon gate journal');
  const lock = new Database(lockPath,{readonly:true,fileMustExist:true,timeout:0});
  try {
    lock.exec('BEGIN EXCLUSIVE');
    if (separateDestination(prepared.root,home,plan).length) throw Error('Interrupted key publication');
    const checked = prepareMigrationPlan(snapshot,plan), current = readReceipt(home,plan);
    if (canonicalPlanValue(current)!==canonicalPlanValue(receipt)) throw Error('Receipt changed');
    const path = join(home,'loom.db');
    const assertCheckpointed = () => {
      for (const suffix of ['-wal','-journal']) if (existsSync(path+suffix) && statSync(path+suffix).size) throw Error('Destination must be stopped and checkpointed');
    };
    assertCheckpointed();
    const commsKeyBefore = plan.importers.comms ? optional(join(home,'comms.key')) : undefined;
    const before = fileDigest(path), db = openSnapshotSqlite(path);
    const report: VerificationReport = {status:'verified',snapshot:plan.snapshot,plan:migrationPlanChecksum(plan),pieces:[],missing:[],differences:[]};
    try {
      for (const [piece,input] of Object.entries(plan.importers)) {
        if (!verifiers.includes(piece)) { report.missing.push(piece); continue; }
        const paths=input.paths.map(p=>join(checked.root,p));
        const runtimeSource=piece==='runtime'?readRuntimeProjection(paths,input.options,join(checked.root,'home')):undefined;
        if(runtimeSource && !compareRuntimeArchive(db,runtimeSource))report.differences.push({piece,table:'runtime_import_chunks',expected:Object.keys(runtimeSource.files).length,actual:null});
        if (piece === 'comms') {
          report.pieces.push(piece);
          const differences = await compareComms(db,input.paths.map(p => snapshotPath({snapshot:{root:checked.root,manifest:checked.manifest}},p)),home);
          report.differences.push(...differences.map(d => ({piece,...d})));
          if (!receipt.completed.includes(piece)) report.differences.push({piece,table:'coordinator-receipt',expected:1,actual:0});
          continue;
        }
        const expected = runtimeSource ? runtimeImportTables(runtimeSource) : await expectedTables(piece,paths,input.options,receipt.now,join(checked.root,'home'));
        report.pieces.push(piece);
        for (const [table,rows] of Object.entries(expected)) {
          const filter=table==='attention_asks' && (piece==='secrets'||plan.importers.secrets) ? (row:Row)=>{
              const secret=JSON.parse(row.record as string).source?.kind==='piece' && JSON.parse(row.record as string).source?.id==='secrets';
              return piece==='secrets'?secret:!secret;
            }:undefined;
          const difference=compareTable(db,table,rows,filter);
          if(difference)report.differences.push({piece,...difference});
        }
        if (!receipt.completed.includes(piece)) report.differences.push({piece,table:'coordinator-receipt',expected:1,actual:0});
        if (piece==='household') {
          const sourceKey = optional(join(checked.root,'home/ui-cookie.key')), targetKey = optional(join(home,'ui-cookie.key'));
          if ((sourceKey || targetKey) && !sourceKey?.equals(targetKey??Buffer.alloc(0))) report.differences.push({piece,table:'cookie-key',expected:sourceKey?1:0,actual:targetKey?1:0});
        }
      }
      prepareMigrationPlan(snapshot,plan); // detect source mutation during projection
      assertCheckpointed(); // a direct writer can bypass the daemon gate
      if (canonicalPlanValue(before)!==canonicalPlanValue(fileDigest(path))) throw Error('Destination changed');
      if (canonicalPlanValue(readReceipt(home,plan))!==canonicalPlanValue(receipt)) throw Error('Receipt changed');
      const expectedKey = optional(join(checked.root,'home/ui-cookie.key')), finalKey = optional(join(home,'ui-cookie.key'));
      if ((expectedKey || finalKey) && !expectedKey?.equals(finalKey??Buffer.alloc(0))) {
        if (!report.differences.some(d=>d.table==='cookie-key')) report.differences.push({piece:'household',table:'cookie-key',expected:expectedKey?1:0,actual:finalKey?1:0});
      }
      if (plan.importers.comms && !commsKeyBefore?.equals(optional(join(home,'comms.key')) ?? Buffer.alloc(0))) throw Error('Comms key changed');
      report.missing.sort();
      report.status = report.differences.length ? 'different' : report.missing.length ? 'incomplete' : 'verified';
      return report;
    } finally { db.close(); }
  } finally { lock.close(); }
}
const usage = 'usage: loom migrate verify --snapshot <directory> --home <stopped-home> [--plan <file> | --runtime-mapping <file>]\n';
/** Standalone Runtime verification has its own owning import metadata, not an all receipt. */
export async function verifyRuntimeMigration(snapshot:string,home:string,options:unknown):Promise<VerificationReport> {
  const prepared=prepareMigrationPlan(snapshot),input=prepared.plan.importers.runtime;
  if(!input)throw Error('Runtime input required');
  separateDestination(prepared.root,home,prepared.plan);
  const lockPath=join(home,'http-daemon-lock.db'),lockBytes=readFileSync(lockPath);
  if(lockBytes.length&&(lockBytes.length<20||lockBytes[18]!==1||lockBytes[19]!==1))throw Error('Unsafe daemon gate');
  for(const suffix of ['-wal','-shm','-journal'])if(existsSync(lockPath+suffix))throw Error('Unsafe daemon gate journal');
  const lock=new Database(lockPath,{readonly:true,fileMustExist:true,timeout:0});
  try {
    lock.exec('BEGIN EXCLUSIVE');
    const path=join(home,'loom.db');assertRuntimeCheckpointed(path);
    const before=fileDigest(path),db=openSnapshotSqlite(path);
    try {
      const sourceHome=join(prepared.root,'home');
      const h=parseHouseholdDocument(sourceHome,JSON.parse(readFileSync(join(sourceHome,'household.json'),'utf8')));
      const current=new HouseholdDatabase(db).household(home);
      if(!sameRuntimeHousehold(current,h))throw Error('Destination household differs from snapshot');
      const source=readRuntimeProjection(input.paths.map(p=>snapshotPath({snapshot:prepared},p)),options,sourceHome,new SharingDatabase(db,home).projectIds());
      const plan={...prepared.plan,importers:{...prepared.plan.importers,runtime:{...input,options:JSON.parse(source.options)}}};
      const report:VerificationReport={status:'verified',snapshot:prepared.plan.snapshot,plan:migrationPlanChecksum(plan),pieces:['runtime'],missing:[],differences:[]};
      for(const [table,expected] of Object.entries(runtimeImportTables(source))) {
        const difference=compareTable(db,table,expected);
        if(difference)report.differences.push({piece:'runtime',...difference});
      }
      if(!compareRuntimeArchive(db,source))report.differences.push({piece:'runtime',table:'runtime_import_chunks',expected:Object.keys(source.files).length,actual:null});
      prepareMigrationPlan(snapshot,prepared.plan);assertRuntimeCheckpointed(path);
      if(canonicalPlanValue(before)!==canonicalPlanValue(fileDigest(path)))throw Error('Runtime destination changed');
      report.status=report.differences.length?'different':'verified';return report;
    } finally {db.close();}
  } finally {lock.close();}
}
export async function migrateVerify(argv: string[], io: IOStreams): Promise<number> {
  let args;
  try { args = parseArgs({args:argv,options:{snapshot:{type:'string'},home:{type:'string'},plan:{type:'string'},'runtime-mapping':{type:'string'},help:{type:'boolean',short:'h'}},strict:true,allowPositionals:false}); }
  catch { io.stderr(usage); return 2; }
  if (args.values.help) { io.stdout(usage); return 0; }
  if (!args.values.snapshot || !args.values.home) { io.stderr(usage); return 2; }
  try {
    if(args.values.plan&&args.values['runtime-mapping'])throw Error('Choose all plan or standalone Runtime mapping');
    const report = args.values['runtime-mapping']
      ? await verifyRuntimeMigration(args.values.snapshot,args.values.home,JSON.parse(readFileSync(args.values['runtime-mapping'],'utf8')))
      : await verifyMigration(args.values.snapshot,args.values.home,args.values.plan ? JSON.parse(readFileSync(args.values.plan,'utf8')) : undefined);
    io.stdout(JSON.stringify(report,null,2)+'\n'); return report.status==='verified'?0:3;
  } catch { io.stderr('Verification refused; check snapshot, plan and migration home, and stop the destination daemon.\n'); return 1; }
}
