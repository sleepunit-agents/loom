/** Owning permission documents. No public body, runner or adapter may supply them. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { operation, OperationError, mayAct, type Db, type Operations, type Sharing } from '../../core/index.js';
import { bodyGates, bodyPolicy } from './body-policy.js';
const agentId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = (message: string): never => { throw new OperationError('conflict', message); };
type ArchivedRow = { collection: string; key: string; record: string };
interface Configuration { revision: number; gates: unknown; policy: unknown; archive: string; proposals: ArchivedRow[] }
/** Exact imported rows remain archived, even after owner edits or proposal decisions. */
function archived(db: Db, agent: string) {
  const predicate = `((collection IN ('gates','policy') AND key=?) OR (collection='gate-proposals' AND
    (substr(key,1,length(?)+1)=?||'.' OR json_extract(CASE WHEN json_valid(json_extract(record,'$.doc')) THEN json_extract(record,'$.doc') ELSE '{}' END,'$.agent')=?)))`;
  const args = [agent,agent,agent,agent];
  // Refuse an unbounded owner response before loading source words. Never truncate.
  const size = db.prepare(`SELECT coalesce(sum(length(CAST(record AS BLOB))),0) AS n FROM runtime_import_documents WHERE ${predicate}`).get(...args) as { n: number };
  if (size.n > 1024*1024) fail('Archived permission documents exceed the review limit');
  const rows = db.prepare(`SELECT collection,key,record FROM runtime_import_documents WHERE ${predicate} ORDER BY collection,key`).all(...args) as ArchivedRow[];
  const document = (collection: string): unknown => {
    const row = rows.find(r => r.collection === collection);
    if (!row) return null;
    try { const source = JSON.parse(row.record); return JSON.parse(source.doc); }
    catch { return fail('Archived permission document is unreadable'); }
  };
  return { key: digest(rows), rows, gates: document('gates'), policy: document('policy'), proposals: rows.filter(r => r.collection === 'gate-proposals') };
}
function stored(db: Db, agent: string): Configuration | undefined {
  const row = db.prepare('SELECT record FROM runtime_body_policy WHERE agent=?').get(agent) as { record: string } | undefined;
  return row ? JSON.parse(row.record) as Configuration : undefined;
}
function valid(gates: unknown, policy: unknown): boolean { return bodyGates.safeParse(gates).success && bodyPolicy.safeParse(policy).success; }
/** Internal only. Re-read after awaits; this is configuration, never launch authority.
 * An inactive archive is a fence even when a newer-looking record already exists.
 */
export function currentBodyPolicy(db: Db, agent: string) {
  agentId.parse(agent);
  const source = archived(db, agent), current = stored(db, agent);
  if (!current || current.archive !== source.key) return fail('Owner permission documents need reconciliation');
  if (!valid(current.gates,current.policy)) return fail('Owner permission documents need repair');
  return { revision: current.revision, key: digest(current), gates: structuredClone(current.gates), policy: structuredClone(current.policy) };
}
export function installBodyPolicyStore(db: Db, operations: Operations, sharing: () => Sharing) {
  // Gate editing was always household-owner work, including another member's agent.
  const may = (viewer: Parameters<typeof mayAct>[0]) => mayAct(viewer,{type:'runtime.body-policy'},sharing(),'household');
  const checkAgent = (agent: string) => {
    if (!Object.values(sharing().members).some(m => m.agents.includes(agent))) throw new OperationError('not-found','No household agent matches');
  };
  operations.register(operation({
    name:'runtime.readBodyPolicy', input:z.object({agent:agentId}).strict(),
    output:z.object({revision:z.number(),archive:z.string(),reconciled:z.boolean(),valid:z.boolean(),gates:z.unknown(),policy:z.unknown(),proposals:z.array(z.unknown()),source:z.array(z.unknown())}), may,
    run(_ctx,{agent}) {
      checkAgent(agent); const source=archived(db,agent), current=stored(db,agent);
      const gates=current?current.gates:source.gates, policy=current?current.policy:source.policy;
      return {revision:current?.revision??0,archive:source.key,reconciled:!!current&&current.archive===source.key,valid:valid(gates,policy),gates,policy,proposals:current?.proposals??source.proposals,source:source.rows};
    },
  }));
  operations.register(operation({
    name:'runtime.adoptBodyPolicy',write:true,
    input:z.object({agent:agentId,archive:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),output:z.object({agent:agentId,revision:z.number()}),may,
    run(_ctx,{agent,archive}) {
      checkAgent(agent); const source=archived(db,agent);
      if(source.key!==archive)fail('Archived permission documents changed since review');
      const before=stored(db,agent);
      if(before) {
        if(before.archive!==archive)fail('Active configuration conflicts with the archive');
        return {agent,revision:before.revision};
      }
      // Preserve absent/malformed logical documents too. They remain fenced until
      // the owner explicitly repairs the paired configuration. Never default them.
      const record:Configuration={revision:1,gates:source.gates,policy:source.policy,archive,proposals:source.proposals};
      db.prepare('INSERT INTO runtime_body_policy VALUES (?,?)').run(agent,JSON.stringify(record));
      return {agent,revision:1};
    },
  }));
  operations.register(operation({
    name:'runtime.configureBodyPolicy',write:true,
    input:z.object({agent:agentId,revision:z.number().int().nonnegative(),gates:z.unknown(),policy:z.unknown()}).strict(),output:z.object({agent:agentId,revision:z.number()}),may,
    run(_ctx,input) {
      checkAgent(input.agent); const source=archived(db,input.agent), before=stored(db,input.agent);
      if(before?.revision!==input.revision && !(input.revision===0&&!before))fail('Permission documents changed since review');
      if((before&&before.archive!==source.key)||(!before&&source.rows.length))fail('Adopt original archived permissions and proposals first');
      if(!valid(input.gates,input.policy))throw new OperationError('invalid','Complete valid gates and policy are required');
      // Validate without replacing the exact owner document with Zod defaults.
      const record:Configuration={revision:(before?.revision??0)+1,gates:input.gates,policy:input.policy,archive:source.key,proposals:before?.proposals??[]};
      db.prepare('INSERT INTO runtime_body_policy VALUES (?,?) ON CONFLICT(agent) DO UPDATE SET record=excluded.record').run(input.agent,JSON.stringify(record));
      return {agent:input.agent,revision:record.revision};
    },
  }));
}
