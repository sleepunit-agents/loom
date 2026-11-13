/** Source-only projections. No destination opens or importer execution. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseTokenDocument } from '../household.js';
import { readSecretImport, type SecretImportOptions } from '../pieces/secrets/import-source.js';
import { parseHouseholdDocument } from '../household.js';
import { readTasksImport } from '../pieces/tasks/importer.js';
import { readAttentionImport, type ImportScopes } from '../pieces/attention/importer.js';
import { readClockImport } from '../pieces/clock/importer.js';
import { readApprovalsImport } from '../pieces/approvals/importer.js';
import { ruleId } from '../pieces/approvals/store.js';
import { readChangesImport } from '../pieces/changes/importer.js';
import { openSnapshotSqlite } from './migration-sqlite.js';
export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;
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
export async function expectedTables(piece: string, paths: string[], options: unknown, now: number, householdHome?: string): Promise<Tables> {
  switch (piece) {
    case 'household': return householdTables(paths[0],now);
    case 'secrets': {
      if(!householdHome)throw Error('Source household required');
      const h=parseHouseholdDocument(householdHome,JSON.parse(readFileSync(join(householdHome,'household.json'),'utf8')));
      const e=readSecretImport(paths[0],now,options as SecretImportOptions,{agents:h.agents,members:h.members.map(m=>m.person)});
      const records=(rs:{id:string}[])=>rs.map(r=>({id:r.id,record:json(r)}));
      return {secrets_names:records(e.records),secrets_requests:records(e.requests),secrets_grants:e.grants.map(g=>({id:g.id,agent:g.agent,kind:g.kind,target:g.target,record:json(g)})),
        secrets_changes:records(e.changes),secrets_uses:e.uses.map(u=>({id:u.id,name:u.name,record:json(u)})),attention_asks:records(e.asks),
        secrets_meta:[{key:'policy',value:json(e.policy)},{key:'legacy-snapshot',value:json(e.legacy)},{key:'source-checksum',value:e.checksum},{key:'source-options',value:e.options}]};
    }
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
