/** Offline source projection. No destination or credential decryption. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { secretName } from './input.js';
import { parseLegacyMetadataJson } from './source-json.js';
import { planLegacySecretRecords, type LegacySecretRecordPrincipals } from './import-records.js';
import type { Ask } from '../attention/role.js';
import type { SecretName } from './role.js';
import type { SecretChange } from './history.js';
import type { SecretUsage } from './usage.js';

export const secretImportOptions = z.object({
  agents: z.record(z.string(), z.string().min(1)), members: z.record(z.string(), z.string().min(1)),
}).strict();
export type SecretImportOptions = z.infer<typeof secretImportOptions>;
export const canonicalSecretImport = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonicalSecretImport).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>`${JSON.stringify(k)}:${canonicalSecretImport(x)}`).join(',')}}`;
  return JSON.stringify(v);
};
const auditSchema = z.object({
  at: z.iso.datetime({precision:3}), event: z.enum(['request','read','refused-read','grant','deny','revoke','always','stop-always','always-on','houses-allow','houses-stop','set','removed','host-read','missing','issue']),
  secret: secretName, id: z.string().regex(/^q-[0-9a-f]{8}$/).optional(), agent: z.string().optional(),
  agents: z.array(z.string()).optional(), house: z.string().regex(/^h-[0-9]{1,9}$/).optional(),
  why: z.string().optional(), result: z.enum(['pending','granted','denied','revoked']).optional(),
  by: z.enum(['owner','policy','runtime']).nullable().optional(), who: z.string().min(1).optional(),
  how: z.enum(['add','replace','restore','get','podman']).optional(),
}).strict();
const optional = (path: string): Buffer | undefined => {
  try { return readFileSync(path); } catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
};
/** Raw encrypted bytes affect receipt only. They never enter the projection. */
export function readSecretImport(from: string, now: number, input: SecretImportOptions,
  registered: {agents: readonly string[]; members: readonly string[]}) {
  try {
    const options = secretImportOptions.parse(input);
    const files = new Map([
      ['store.sops.json', optional(join(from,'store.sops.json'))],
      ['policy.json', optional(join(from,'policy.json'))],
      ['requests.json', optional(join(from,'requests.json'))],
      ['audit.jsonl', optional(join(from,'audit.jsonl'))],
    ]);
    if([...files.values()].every(b=>b===undefined))throw Error();
    const file=(name:string,fallback:string)=>files.get(name)??Buffer.from(fallback);
    const store = z.record(z.string(), z.unknown()).parse(parseLegacyMetadataJson(file('store.sops.json','{}')));
    if(Object.entries(store).some(([n,v])=>n!=='sops' && (typeof v!=='string'||!v.startsWith('ENC[AES256_GCM,')||!v.endsWith(']'))))throw Error();
    const names = Object.keys(store).filter(n=>n!=='sops').sort();
    for (const name of names) secretName.parse(name);
    const principals: LegacySecretRecordPrincipals = { bindings:new Map(Object.entries(options.agents)), registered:new Set(registered.agents),
      members:new Map(Object.entries(options.members)), registeredMembers:new Set(registered.members) };
    const plan = planLegacySecretRecords(file('policy.json','{}'),file('requests.json','{"v":1,"requests":{}}'),principals,new Set(names),now,{pendingAttention:true});
    // Audit-only identities must satisfy the same exact, injective mapping.
    for (const [map, ids] of [[options.agents,registered.agents],[options.members,registered.members]] as const) {
      if (new Set(Object.values(map)).size!==Object.keys(map).length || Object.values(map).some(id=>!ids.includes(id))) throw Error();
    }
    const audit = new TextDecoder('utf-8',{fatal:true}).decode(file('audit.jsonl','')).split('\n').filter(line=>line.trim()).map(line=>auditSchema.parse(parseLegacyMetadataJson(Buffer.from(line))));
    const agent = (id: string) => { if(!Object.hasOwn(options.agents,id))throw Error(); return options.agents[id]; };
    const member = (id: string) => { if(!Object.hasOwn(options.members,id))throw Error(); return options.members[id]; };
    const changes: SecretChange[] = [], uses: SecretUsage[] = [];
    audit.forEach((e,i)=>{
      const at=Date.parse(e.at), id=`legacy-${String(i).padStart(12,'0')}`;
      if(at>now)throw Error();
      if(e.agent!==undefined)agent(e.agent);
      for(const a of e.agents??[])agent(a);
      if(e.who!==undefined)member(e.who);
      if(e.event==='set'||e.event==='removed') {
        if(e.event==='set' && !['add','replace','restore'].includes(e.how??''))throw Error();
        changes.push({id,name:e.secret,action:e.event==='removed'?'removed':e.how==='replace'?'replace':'add',by:e.who?member(e.who):'legacy:unattributed',at});
      }
      if(['read','issue','host-read','refused-read'].includes(e.event)) {
        if(e.event!=='host-read' && e.agent===undefined)throw Error();
        uses.push({id,name:e.secret,action:e.event==='issue'?'issue':e.event==='host-read'?'service-use':'read',
          by:e.event==='host-read'?{kind:'service',id:'legacy-host'}:{kind:'agent',id:agent(e.agent!)},at,
          state:e.event==='refused-read'?'failed':'released',...(e.house?{house:e.house}:{})});
      }
    });
    const records: SecretName[] = names.map(id=>{
      const last=changes.filter(e=>e.name===id && e.action!=='removed').sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id)).at(-1);
      return {id,description:'',changedAt:last?.at??0,by:last?.by??'legacy:unattributed'};
    });
    const asks: Ask[] = plan.requests.filter(r=>r.state==='pending').map(r=>({id:r.id,source:{kind:'piece',id:'secrets'},sourceManaged:true,
      ask:`Allow ${r.agent} to use ${r.target}?`,why:r.why,if_yes:'I grant this request.',if_no:'I deny this request.',
      answers:'yes-no',refs:[r.id],href:'/p/settings-preview',state:'open',createdAt:r.createdAt,changedAt:r.createdAt}));
    const checksum=createHash('sha256').update(canonicalSecretImport([...files].map(([n,b])=>[n,b?.toString('base64')??null]))).digest('hex');
    const legacy={policy:plan.metadata.sourcePolicy,requests:plan.metadata.requests.requests.map(r=>r.source),audit};
    return {checksum,options:canonicalSecretImport(options),records,requests:plan.requests,grants:plan.grants,policy:plan.metadata.policy,changes,uses,asks,legacy};
  } catch { throw Error('Invalid legacy secrets source or identity mapping'); }
}
