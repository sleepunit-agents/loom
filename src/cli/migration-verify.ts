/** Offline comparison only. No foundation, migrations, importer calls or writable opens. */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { expectedTables, type Row } from './migration-projection.js';
import { readReceipt, separateDestination } from './migration-all.js';
import { canonicalPlanValue, migrationPlanChecksum, prepareMigrationPlan } from './migration-plan.js';
import { openSnapshotSqlite } from './migration-sqlite.js';
import type { IOStreams } from './io.js';

export interface VerificationDifference { piece: string; table: string; expected: number; actual: number | null }
export interface VerificationReport { status: 'verified' | 'different' | 'incomplete'; snapshot: string; plan: string; pieces: string[]; missing: string[]; differences: VerificationDifference[] }
const optional = (path: string): Buffer | undefined => existsSync(path) ? readFileSync(path) : undefined;
const verifiers = ['household','tasks','attention','clock','approvals','changes'];
/** Compare JSON semantically; ordering is retained inside records, table row order is immaterial. */
function normalize(records: Row[]): string {
  return canonicalPlanValue(records.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key, (key==='body'||key==='record') && typeof value==='string' ? JSON.parse(value) : value]))).map(row=>canonicalPlanValue(row)).sort());
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
    const before = readFileSync(path), db = openSnapshotSqlite(path);
    const report: VerificationReport = {status:'verified',snapshot:plan.snapshot,plan:migrationPlanChecksum(plan),pieces:[],missing:[],differences:[]};
    try {
      for (const [piece,input] of Object.entries(plan.importers)) {
        if (!verifiers.includes(piece)) { report.missing.push(piece); continue; }
        const expected = await expectedTables(piece,input.paths.map(p=>join(checked.root,p)),input.options,receipt.now);
        report.pieces.push(piece);
        for (const [table,rows] of Object.entries(expected)) {
          let actual: Row[] | null = null;
          try {
            const columns = table==='approvals_approvals'||table==='approvals_rules' ? 'rowid AS migration_order, *' : '*';
            actual = db.prepare(`SELECT ${columns} FROM ${table}`).all() as Row[];
          } catch { /* missing schema is a difference */ }
          let equal = false; try { equal = actual!==null && normalize(actual)===normalize(rows); } catch { /* corrupt record is a difference */ }
          if (!equal) report.differences.push({piece,table,expected:rows.length,actual:actual?.length??null});
        }
        if (!receipt.completed.includes(piece)) report.differences.push({piece,table:'coordinator-receipt',expected:1,actual:0});
        if (piece==='household') {
          const sourceKey = optional(join(checked.root,'home/ui-cookie.key')), targetKey = optional(join(home,'ui-cookie.key'));
          if ((sourceKey || targetKey) && !sourceKey?.equals(targetKey??Buffer.alloc(0))) report.differences.push({piece,table:'cookie-key',expected:sourceKey?1:0,actual:targetKey?1:0});
        }
      }
      prepareMigrationPlan(snapshot,plan); // detect source mutation during projection
      assertCheckpointed(); // a direct writer can bypass the daemon gate
      if (!before.equals(readFileSync(path))) throw Error('Destination changed');
      if (canonicalPlanValue(readReceipt(home,plan))!==canonicalPlanValue(receipt)) throw Error('Receipt changed');
      const expectedKey = optional(join(checked.root,'home/ui-cookie.key')), finalKey = optional(join(home,'ui-cookie.key'));
      if ((expectedKey || finalKey) && !expectedKey?.equals(finalKey??Buffer.alloc(0))) {
        if (!report.differences.some(d=>d.table==='cookie-key')) report.differences.push({piece:'household',table:'cookie-key',expected:expectedKey?1:0,actual:finalKey?1:0});
      }
      report.missing.sort();
      report.status = report.differences.length ? 'different' : report.missing.length ? 'incomplete' : 'verified';
      return report;
    } finally { db.close(); }
  } finally { lock.close(); }
}
const usage = 'usage: loom migrate verify --snapshot <directory> --home <stopped-home> [--plan <file>]\n';
export async function migrateVerify(argv: string[], io: IOStreams): Promise<number> {
  let args;
  try { args = parseArgs({args:argv,options:{snapshot:{type:'string'},home:{type:'string'},plan:{type:'string'},help:{type:'boolean',short:'h'}},strict:true,allowPositionals:false}); }
  catch { io.stderr(usage); return 2; }
  if (args.values.help) { io.stdout(usage); return 0; }
  if (!args.values.snapshot || !args.values.home) { io.stderr(usage); return 2; }
  try {
    const report = await verifyMigration(args.values.snapshot,args.values.home,args.values.plan ? JSON.parse(readFileSync(args.values.plan,'utf8')) : undefined);
    io.stdout(JSON.stringify(report,null,2)+'\n'); return report.status==='verified'?0:3;
  } catch { io.stderr('Verification refused; check snapshot, plan and migration home, and stop the destination daemon.\n'); return 1; }
}
