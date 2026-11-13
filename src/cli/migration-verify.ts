/** Offline comparison only. No foundation, migrations, importer calls or writable opens. */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseTokenDocument } from '../household.js';
import { readTasksImport } from '../pieces/tasks/importer.js';
import { readAttentionImport, type ImportScopes } from '../pieces/attention/importer.js';
import { readClockImport } from '../pieces/clock/importer.js';
import { readApprovalsImport } from '../pieces/approvals/importer.js';
import { ruleId } from '../pieces/approvals/store.js';
import { readChangesImport } from '../pieces/changes/importer.js';
import { readReceipt, separateDestination } from './migration-all.js';
import { canonicalPlanValue, migrationPlanChecksum, prepareMigrationPlan } from './migration-plan.js';
import { openSnapshotSqlite } from './migration-sqlite.js';
import type { IOStreams } from './io.js';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
export interface VerificationDifference { piece: string; table: string; expected: number; actual: number | null }
export interface VerificationReport { status: 'verified' | 'different' | 'incomplete'; snapshot: string; plan: string; pieces: string[]; missing: string[]; differences: VerificationDifference[] }
const json = (value: unknown) => JSON.stringify(value);
const optional = (path: string): Buffer | undefined => existsSync(path) ? readFileSync(path) : undefined;
const document = (path: string, fallback: Row): Row => JSON.parse(optional(path)?.toString('utf8') ?? JSON.stringify(fallback));
const rows = (value: Row): Row[] => Object.entries(value).map(([id, body]) => ({ id, body: json(body) }));
/** Construct physical rows from source documents, including envelope membership and hidden credentials. */
function householdTables(from: string, now: number): Tables {
  const household = document(join(from,'household.json'), {}), { agents, members, ...fields } = household;
  const tokens = parseTokenDocument(document(join(from,'tokens.json'), { v:1, tokens:[] }));
  const { tokens: records, ...tokenFields } = tokens;
  const groups = new Map<string, typeof records>();
  for (const token of records) groups.set(token.sha256, [...(groups.get(token.sha256) ?? []), token]);
  const sessions = document(join(from,'ui-sessions.json'), {v:1,sessions:{}}), envelope = {...sessions};
  const tables: Tables = {
    household_agents: [...new Set(agents as string[])].map(id => ({id,body:json(id)})),
    household_members: ((members ?? []) as Row[]).map(m => ({id:m.person,body:json(m)})),
    household_projects: [], household_tokens: [...groups].map(([id,body])=>({id,body:json(body)})),
    household_token_use: rows(document(join(from,'tokens.used.json'),{})),
    household_readers: rows((sessions.members ?? {}) as Row), household_push: [], household_piece_settings: [],
  };
  for (const concern of ['sessions','links','challenges','passkeys']) {
    tables[`household_${concern}`] = rows((sessions[concern] ?? {}) as Row);
    if (Object.hasOwn(sessions,concern)) Object.defineProperty(envelope,concern,{value:{},enumerable:true});
  }
  if (Object.hasOwn(sessions,'members')) envelope.members = {};
  delete envelope.push;
  if (sessions.push !== undefined) {
    const push = sessions.push as Row, meta = {...push};
    if (Object.hasOwn(push,'subs')) meta.subs = {};
    tables.household_push = [{id:'state',body:json(meta)}, ...Object.entries((push.subs ?? {}) as Row).map(([id,body])=>({id:`sub:${id}`,body:json(body)}))];
  }
  tables.household_settings = [
    {id:'household-envelope',body:json({fields,agents,...(members === undefined ? {} : {members:(members as Row[]).map(m=>m.person)})})},
    {id:'token-envelope',body:json({fields:tokenFields,digests:records.map(t=>t.sha256)})},
    {id:'session-envelope',body:json(envelope)},
  ];
  const pieces = join(from,'pieces');
  const files = new Map(['household.json','tokens.json','tokens.used.json','ui-sessions.json','ui-cookie.key'].map(name=>[name,optional(join(from,name))]));
  if (existsSync(pieces)) for (const name of readdirSync(pieces).sort()) {
    const path = `pieces/${name}/settings.json`, body = optional(join(from,path));
    if (body !== undefined) { files.set(path,body); tables.household_piece_settings.push({id:name,body:json(JSON.parse(body.toString('utf8')))}); }
  }
  // Match the import receipt independently, without trusting it as evidence of content.
  tables.household_imports = [{id:'legacy-home',body:json({checksum:hash(JSON.stringify([...files].map(([p,b])=>[p,b?.toString('base64')??null]))),at:now})}];
  return tables;
}
import { createHash } from 'node:crypto';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function expectedTables(piece: string, paths: string[], options: unknown, now: number): Tables {
  switch (piece) {
    case 'household': return householdTables(paths[0],now);
    case 'tasks': {
      const {expected,checksum,mapping,agent} = readTasksImport(paths[0],now,options as Parameters<typeof readTasksImport>[2],openSnapshotSqlite);
      return {tasks_tasks:expected.tasks.map((t,ord)=>({ord,id:t.id,record:json(t),changed_at:now})), tasks_links:expected.links.map((l,ord)=>({ord,record:json(l)})), tasks_meta:[{key:'seq',value:String(expected.seq)},{key:'source-checksum',value:checksum},{key:'source-projects',value:mapping},{key:'source-agent',value:agent}]};
    }
    case 'attention': {
      const {expected,checksum} = readAttentionImport(paths,options as ImportScopes,{},openSnapshotSqlite);
      return {...expected,attention_statuses:[],attention_import:[{id:'source',checksum}]};
    }
    case 'clock': {
      const {expectedWakes,expectedSchedules,pauses,source,checksum} = readClockImport(paths[0],now);
      return {clock_wakes:expectedWakes.map(w=>({id:w.id,record:json(w),changed_at:now})),clock_schedules:expectedSchedules.map(s=>({id:s.id,record:json(s),changed_at:now})),clock_pauses:pauses,clock_events:[],clock_meta:[{key:'legacy-snapshot',value:source},{key:'source-checksum',value:checksum}]};
    }
    case 'approvals': {
      const {expected:s,checksum} = readApprovalsImport(paths[0],options as Parameters<typeof readApprovalsImport>[1]);
      return {approvals_approvals:s.approvals.map((a,i)=>({migration_order:i+1,id:a.id,record:json(a),changed_at:now})),approvals_rules:[...s.rules,...s.grants,...s.standing].map((r,i)=>({migration_order:i+1,id:ruleId(r),record:json(r)})),approvals_notices:s.notices.map((r,id)=>({id,record:json(r)})),approvals_audit:s.audit.map((r,i)=>({id:i+1,record:json(r)})),approvals_meta:[{key:'source-checksum',value:checksum}]};
    }
    case 'changes': {
      // Household import creates no sharing projects. Post-import changes are differences too.
      const {expected,checksum} = readChangesImport(paths[0],{...(options as {attribution:Parameters<typeof readChangesImport>[1]['attribution']}),projects:[]});
      return {changes_changes:expected.map(c=>({id:c.id,repo:c.repo,record:json(c)})),changes_jobs:[],changes_meta:[{key:'source-checksum',value:checksum}]};
    }
    default: throw Error('No independent verifier');
  }
}
const verifiers = ['household','tasks','attention','clock','approvals','changes'];
/** Compare JSON semantically; ordering is retained inside records, table row order is immaterial. */
function normalize(records: Row[]): string {
  return canonicalPlanValue(records.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key, (key==='body'||key==='record') && typeof value==='string' ? JSON.parse(value) : value]))).map(row=>canonicalPlanValue(row)).sort());
}
export function verifyMigration(snapshot: string, destination: string, supplied?: unknown): VerificationReport {
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
        const expected = expectedTables(piece,input.paths.map(p=>join(checked.root,p)),input.options,receipt.now);
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
export function migrateVerify(argv: string[], io: IOStreams): number {
  let args;
  try { args = parseArgs({args:argv,options:{snapshot:{type:'string'},home:{type:'string'},plan:{type:'string'},help:{type:'boolean',short:'h'}},strict:true,allowPositionals:false}); }
  catch { io.stderr(usage); return 2; }
  if (args.values.help) { io.stdout(usage); return 0; }
  if (!args.values.snapshot || !args.values.home) { io.stderr(usage); return 2; }
  try {
    const report = verifyMigration(args.values.snapshot,args.values.home,args.values.plan ? JSON.parse(readFileSync(args.values.plan,'utf8')) : undefined);
    io.stdout(JSON.stringify(report,null,2)+'\n'); return report.status==='verified'?0:3;
  } catch { io.stderr('Verification refused; check snapshot, plan and migration home, and stop the destination daemon.\n'); return 1; }
}
