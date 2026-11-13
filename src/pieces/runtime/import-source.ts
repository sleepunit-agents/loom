/** Offline runtime snapshot reader. No legacy imports, programs or live paths. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { fileDigest } from '../../core/migration-files.js';
import { records, type RuntimeRecords } from './records.js';

export const runtimeRepositoryCacheRule = 'runtime-rebuildable-repo-mirror';

const identity = z.string().min(1).max(200);
const audience = z.object({ member: identity.optional(), project: identity.optional() }).strict();
/** Nulls in a derived plan require a deliberate mapping before any import. */
export const runtimeImportOptions = z.object({
  boxes: z.record(identity, identity.nullable()),
  jobs: z.record(identity, audience.nullable()),
  conversations: z.record(identity, audience.nullable()),
}).strict();
export type RuntimeImportOptions = z.infer<typeof runtimeImportOptions>;
export interface RuntimeImportSources { store?: string; state?: string; data?: string; household?: string }
export interface RuntimeImportIdentities { agents: readonly string[]; members: readonly string[]; projects: readonly string[] }
type Row = Record<string, unknown>;
const object = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid runtime source object');
  return value as Row;
};
const optionalObject = (value: unknown): Row => value === undefined ? {} : object(value);
export const canonicalRuntimeSource = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalRuntimeSource).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonicalRuntimeSource(v)}`).join(',')}}`;
  return JSON.stringify(value);
};
const stamp = (value: unknown): number => {
  if (typeof value !== 'string') throw Error('Invalid runtime source timestamp');
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result)) throw Error('Invalid runtime source timestamp');
  return result;
};
const text = (value: unknown): string => identity.parse(value);

/** Inventory every regular file in the explicitly supplied roots, including unknown records.
 * Root-relative names, exact bytes and complete logical SQLite rows are private archival
 * data, not authority, registry records or executable input. Refuse links/special files.
 */
export function readRuntimeInventory(sources: RuntimeImportSources, open: (path: string) => Database.Database) {
  if (!sources.store && !sources.state && !sources.data) throw Error('No runtime source');
  const files: Record<string,{bytes:number;sha256:string}> = {};
  const filePaths: Record<string,string> = {};
  function walk(path: string, key: string, directory: boolean): void {
    if(key==='data/logins' || key.startsWith('data/logins/'))throw Error('Runner login values must remain outside the runtime import');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('Runtime source contains a symlink');
    // Source-owned mirrors are rebuilt by clone --mirror / fetch --prune and
    // mounted read-only in houses. House working trees and delivery are not caches.
    if(key==='data/repos' && stat.isDirectory())return;
    if (directory && !stat.isDirectory()) throw Error('Runtime source root must be a directory');
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path,name),`${key}/${name}`,false);
    else if (stat.isFile()) { files[key] = fileDigest(path); filePaths[key]=path; }
    else throw Error('Runtime source contains a special file');
  }
  if (sources.store) {
    if (!lstatSync(sources.store).isFile()) throw Error('Runtime store must be a regular file');
    walk(sources.store,'store.db',false);
  }
  if (sources.state) walk(sources.state,'state',true);
  if (sources.data) walk(sources.data,'data',true);
  if(sources.household) {
    if(!lstatSync(sources.household).isFile())throw Error('Runtime Comms source must be a regular file');
    walk(sources.household,'comms-household.db',false);
  }
  const json = (key: string): unknown => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(filePaths[key])));
  const state = files['state/state.json'] === undefined ? undefined : object(json('state/state.json'));
  // An explicitly inventoried empty root supplies no state; never invent a local box.
  if (state && state.v !== 1) throw Error('Unknown runtime state version');
  const conversations = Object.entries(files).filter(([key]) => /^data\/delivery\/conversations\/[^/]+\.json$/.test(key)).map(([key]) => {
    const value = object(json(key));
    if (!/^cv-[0-9a-f]{12}$/.test(text(value.conversation)) || key !== `data/delivery/conversations/${value.conversation}.json`) throw Error('Invalid runtime conversation identity');
    return value;
  });
  let documents: Row[] = [], revisions: Row[] = [];
  let privateThreads:Row[]=[], deletedThreads:Row[]=[];
  if(sources.household) {
    const db=open(sources.household);
    try{
      privateThreads=db.prepare('SELECT id,conversation,agent,member,project FROM comms_threads ORDER BY id').all() as Row[];
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comms_deleted'").get()) {
        const hasConversation=(db.prepare('PRAGMA table_info(comms_deleted)').all() as {name:string}[]).some(column=>column.name==='conversation');
        deletedThreads=db.prepare(`SELECT id,${hasConversation?'conversation':'NULL AS conversation'},agent,member FROM comms_deleted ORDER BY id`).all() as Row[];
      }
    }
    finally{db.close();}
  }
  if (sources.store) {
    const db = open(sources.store);
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
      if (canonicalRuntimeSource(tables) !== '["docs","revisions"]') throw Error('Unknown runtime store tables');
      documents = db.prepare('SELECT collection,key,doc,rev,updated,by FROM docs ORDER BY collection,key').all() as Row[];
      revisions = db.prepare('SELECT id,collection,key,doc,rev,op,at,by FROM revisions ORDER BY id').all() as Row[];
      for (const row of [...documents,...revisions]) {
        text(row.collection); text(row.key);
        if (!Number.isSafeInteger(row.rev) || Number(row.rev) < 1) throw Error('Invalid runtime store revision');
        if (row.doc !== null) JSON.parse(z.string().parse(row.doc));
      }
    } finally { db.close(); }
  }
  const source = canonicalRuntimeSource({roots:Object.keys(sources).filter(key=>sources[key as keyof RuntimeImportSources]!==undefined).sort(),files,documents,revisions,privateThreads,deletedThreads});
  return {files,filePaths,state,conversations,documents,revisions,privateThreads,deletedThreads,source,checksum:createHash('sha256').update(source).digest('hex')};
}

/** Explicit mappings prevent guessing a job's audience from prose or old bearer keys. */
export function readRuntimeImport(sources: RuntimeImportSources, supplied: unknown, identities: RuntimeImportIdentities,
  open: (path: string) => Database.Database, controls: { afterSnapshot?: () => void } = {}) {
  const inventory = readRuntimeInventory(sources,open), options = runtimeImportOptions.parse(supplied);
  const state = inventory.state ?? {}, boxes = optionalObject(state.boxes), houses = optionalObject(state.houses), agents = optionalObject(state.agents), primaries = optionalObject(state.primaries);
  const exact = (mapping: object, ids: string[]) => {
    if (canonicalRuntimeSource(Object.keys(mapping).sort()) !== canonicalRuntimeSource(ids.sort())) throw Error('Runtime mapping must cover every source id exactly');
  };
  exact(options.boxes,Object.keys(boxes)); exact(options.jobs,Object.keys(houses));
  exact(options.conversations,inventory.conversations.map(c=>text(c.conversation)));
  const knownAgent = (value: unknown) => { const id = text(value); if (!identities.agents.includes(id)) throw Error('Unknown runtime agent'); return id; };
  const scope = (value: z.infer<typeof audience> | null | undefined) => {
    if (!value) throw Error('Runtime audience mapping required');
    if (value.member && !identities.members.includes(value.member)) throw Error('Unknown runtime audience member');
    if (value.project && !identities.projects.includes(value.project)) throw Error('Unknown runtime audience project');
    return value;
  };
  const expected: { [K in keyof RuntimeRecords]: RuntimeRecords[K][] } = {box:[],job:[],settings:[],binding:[]};
  for (const [id,raw] of Object.entries(boxes)) {
    const box = object(raw), owner = options.boxes[id];
    if (!owner || !identities.members.includes(owner)) throw Error('Runtime box owner mapping required');
    // Existing ownership may not be silently rewritten by the migration map.
    if (box.owner !== undefined && box.owner !== owner) throw Error('Runtime box owner differs from source');
    if(box.mayHost!==undefined&&box.mayHost!=='*')for(const agent of z.array(identity).parse(box.mayHost))knownAgent(agent);
    for(const agent of z.array(identity).parse(box.lentTo??[]))knownAgent(agent);
    if(box.local&&box.reportOnly)throw Error('Local runtime box cannot be report-only');
    expected.box.push(records.box.parse({id,name:box.name??id,owner,local:box.local??false,mayHost:box.mayHost??'*',lentTo:box.lentTo??[],facts:box.facts??[],labels:box.labels??[],alwaysOn:box.local?true:box.alwaysOn??false,reportOnly:box.reportOnly??false,createdAt:stamp(box.created),...(box.lastSeen ? {lastSeen:stamp(box.lastSeen)}:{}),...(box.revoked ? {revokedAt:stamp(box.revoked)}:{})}));
  }
  if (expected.box.filter(b=>b.local).length > 1) throw Error('Multiple runtime local boxes');
  const settingsAgents = [...new Set([...Object.keys(agents),...Object.keys(primaries)])].sort();
  for (const id of settingsAgents) {
    knownAgent(id);
    const preferences = primaries[id] === undefined ? [] : Array.isArray(primaries[id]) ? primaries[id] : [primaries[id]];
    if ((preferences as unknown[]).some(box=>typeof box !== 'string' || !Object.hasOwn(boxes,box))) throw Error('Unknown runtime preference box');
    const prefs = preferences as string[];
    if(new Set(prefs).size!==prefs.length)throw Error('Duplicate runtime preference box');
    // House configuration and its capabilities remain archived together: dropping
    // restrictions while enabling a house would widen the old login/secret policy.
    expected.settings.push(records.settings.parse({id,agent:id,boxes:prefs}));
  }
  const terminal = new Set(['done','failed','stopped','lost']);
  for (const [id,raw] of Object.entries(houses)) {
    const house = object(raw), agent = knownAgent(house.agent), box = text(house.box);
    if (house.id !== id || !Object.hasOwn(boxes,box)) throw Error('Invalid runtime job identity or box');
    if (!['wanted','starting','running','waiting','stopping','done','failed','stopped','lost','uncertain'].includes(text(house.state))) throw Error('Unknown runtime job state');
    // No imported job is claimable. Active work needs authoritative runner reconciliation.
    expected.job.push(records.job.parse({id,agent,...scope(options.jobs[id]),box,runner:box,title:'Imported runtime work',state:terminal.has(String(house.state))?house.state:'uncertain',imported:{history:house.writtenOff?'discard':'unknown'},createdAt:stamp(house.created),...(terminal.has(String(house.state))&&house.updated?{endedAt:stamp(house.updated)}:{}),...(house.service?{service:house.service}:{})}));
  }
  const skipped: {id:string;reason:'skipped: owning Comms thread deleted'}[] = [];
  for (const c of inventory.conversations) {
    const id = text(c.conversation), audience = scope(options.conversations[id]);
    const agent=knownAgent(c.agent);
    // Comms places use th:<id>, while the old household tables store the bare id.
    // Older fixtures/stores can retain the full place as the table id.
    const placeId=typeof c.place==='string'&&c.place.startsWith('th:')?c.place.slice(3):undefined;
    const threads=inventory.privateThreads.filter(t=>t.conversation===id || t.id===c.place || (placeId!==undefined&&t.id===placeId));
    const deleted=inventory.deletedThreads.filter(t=>t.conversation===id || (placeId!==undefined&&(t.id===placeId || t.id===c.place)));
    if(deleted.length) {
      const tombstone=deleted[0];
      if(deleted.length!==1 || threads.length || placeId===undefined || (tombstone.id!==placeId&&tombstone.id!==c.place) || tombstone.agent!==agent || typeof tombstone.member!=='string' || !identities.members.includes(tombstone.member)
        || (tombstone.conversation!==null&&tombstone.conversation!==id)
        || (audience.member!==undefined&&audience.member!==tombstone.member) || audience.project!==undefined)
        throw Error('Runtime deleted binding must match the owning Comms source');
      skipped.push({id,reason:'skipped: owning Comms thread deleted'});continue;
    }
    if(c.venue==='loom' || c.venue==='spawn' || placeId!==undefined || threads.length) {
      if(!audience.member)throw Error('Private Comms conversation requires a member');
      if(threads.length!==1 || threads[0].conversation!==id || (threads[0].id!==c.place&&threads[0].id!==placeId)
        || threads[0].agent!==agent || threads[0].member!==audience.member
        || (audience.project!==undefined&&threads[0].project!==audience.project))throw Error('Runtime private audience must match the owning Comms source');
    }
    // Old run/body/home pointers and signed attestations are retained only in the archive.
    expected.binding.push(records.binding.parse({id,agent:knownAgent(c.agent),...audience,venue:c.venue,place:c.place}));
  }
  controls.afterSnapshot?.();
  if (readRuntimeInventory(sources,open).source !== inventory.source) throw Error('Runtime source changed during import');
  return {...inventory,expected,skipped,options:canonicalRuntimeSource(options)};
}
