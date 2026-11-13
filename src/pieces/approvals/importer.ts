/** Offline only. Old files are read solely here, never on the daemon's request path. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { migrate, type Db } from '../../core/index.js';
import { schema } from './schema/001.js';
import { type Approval, type Rule, type Standing, type State } from './model.js';
import { load, persist } from './store.js';
import { approvalSchema, standingSchema, ruleSchema, noticeSchema, auditSchema } from './validation.js';
import { person } from './targets.js';
import { ruleId } from './store.js';
import { validScope } from './rules.js';
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}` : JSON.stringify(value);
const object = (value: unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function importApprovals(db: Db, from: string, now: number, options: { interrupt?:()=>void; projects?:Record<string,string> } = {}) {
  const files = ['approvals.json','rules.json','audit.jsonl'].map(name => ({name,text:existsSync(join(from,name))?readFileSync(join(from,name),'utf8'):undefined}));
  if (files[0].text === undefined) throw Error('Source approvals.json is required');
  const doc = JSON.parse(files[0].text) as unknown;
  if (!object(doc) || doc.v !== 1 || !object(doc.approvals)) throw Error('Invalid approvals source');
  const approvals = Object.entries(doc.approvals).map(([id,a]) => {
    if (!object(a) || id !== a.id || !approvalSchema.safeParse(a).success) throw Error(`Invalid source approval ${id}`);
    return a as unknown as Approval;
  });
  const rulesDoc = files[1].text === undefined ? {v:1,rules:[],grants:[],standing:[]} : JSON.parse(files[1].text);
  if (!object(rulesDoc) || rulesDoc.v !== 1 || !Array.isArray(rulesDoc.rules) || (rulesDoc.grants !== undefined && !Array.isArray(rulesDoc.grants)) || (rulesDoc.standing !== undefined && !Array.isArray(rulesDoc.standing))) throw Error('Invalid rules source');
  const validRule = (r: unknown) => ruleSchema.safeParse(r).success && object(r) && ['merge','host'].includes(String(r.kind)) && ['do','tell','ask'].includes(String(r.tier)) && typeof r.scope === 'string' && validScope(r.scope,String(r.kind));
  if (!rulesDoc.rules.every(validRule) || !(rulesDoc.grants as unknown[] ?? []).every(r => validRule(r) && object(r) && typeof r.person === 'string' && person.test(r.person) && !['owner','?'].includes(r.person) && r.kind !== 'host')) throw Error('Invalid source rule or grant');
  for (const j of (rulesDoc.standing ?? []) as unknown[]) if (!standingSchema.safeParse(j).success) throw Error('Invalid standing job source');
  const ruleKeys = [...rulesDoc.rules, ...(rulesDoc.grants ?? []) as unknown[], ...(rulesDoc.standing ?? []) as unknown[]].map(r => ruleId(r as Rule | Standing));
  if (new Set(ruleKeys).size !== ruleKeys.length) throw Error('Duplicate source rule or standing job');
  if (doc.notices !== undefined && (!Array.isArray(doc.notices) || !doc.notices.every(n => noticeSchema.safeParse(n).success))) throw Error('Invalid notices source');
  const audit = files[2].text?.split('\n').filter(s=>s.trim()).map(line=>{const r=JSON.parse(line);if(!auditSchema.safeParse(r).success)throw Error('Invalid audit source');return r;}) ?? [];
  const projects=options.projects??{};
  if(Object.values(projects).some(p=>typeof p!=='string'||!person.test(p)||p.length>80))throw Error('Invalid approval project map');
  const checksum=createHash('sha256').update(canonical({files,projects})).digest('hex');
  return db.transaction(()=>{
    migrate(db,'approvals',schema);
    const marker=db.prepare("SELECT value FROM approvals_meta WHERE key='source-checksum'").get() as {value:string}|undefined;
    if(marker){if(marker.value!==checksum)throw Error('A different approvals source was already imported');return {ok:true,imported:false,checksum,approvals:approvals.length};}
    const held=load(db);if(Object.values(held).some(rows=>rows.length))throw Error('Approvals destination must be empty before import');
    const expected:State={approvals:structuredClone(approvals),rules:rulesDoc.rules as unknown as Rule[],grants:(rulesDoc.grants??[]) as unknown as Rule[],standing:(rulesDoc.standing??[]) as unknown as Standing[],notices:(doc.notices??[]) as State['notices'],audit};
    for(const a of expected.approvals){
      // Explicit migration map: approval id or its proven conversation; no title or repo guessing.
      const project=projects[a.id]??(a.conversation?projects[a.conversation]:undefined);
      if(project)a.project=project;
      a.agent=a.who.agent;
    }
    persist(db,expected,now);options.interrupt?.();
    if(canonical(load(db))!==canonical(expected))throw Error('Approvals import comparison failed: ids, counts or content differ');
    db.prepare("INSERT INTO approvals_meta VALUES ('source-checksum',?)").run(checksum);
    return {ok:true,imported:true,checksum,approvals:expected.approvals.length,rules:expected.rules.length,grants:expected.grants.length,standing:expected.standing.length,notices:expected.notices.length,audit:expected.audit.length};
  })();
}
