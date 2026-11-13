/** Offline evidence only: raw store documents are never setup records or authority. */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { basename } from 'node:path';
import type Database from 'better-sqlite3';
import { fileDigest } from '../../core/migration-files.js';

export interface BridgeStoreFile {
  /** Snapshot-relative name. The caller must confine path with snapshotPath. */
  name: string;
  path: string;
  kind: 'shuttle' | 'runtime';
}
export interface BridgeStoreDocument { collection: string; key: string; doc: string; rev: number; updated: string; by: string }
export interface BridgeStoreRevision { id: number; collection: string; key: string; doc: string | null; rev: number; op: string; at: string; by: string }
export interface BridgeStoreInventory {
  checksum: string;
  stores: { name: string; kind: BridgeStoreFile['kind']; sha256: string; bytes: number;
    documents: BridgeStoreDocument[]; revisions: BridgeStoreRevision[] }[];
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown): string => { if (typeof value !== 'string') throw Error(); return value; };
const positive = (value: unknown): number => {
  if (typeof value !== 'bigint' || value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error();
  return Number(value);
};
const json = (value: unknown): string => { const raw = text(value); JSON.parse(raw); return raw; };
const columns = {
  docs: ['collection','key','doc','rev','updated','by'],
  revisions: ['id','collection','key','doc','rev','op','at','by'],
} as const;
/** Only explicit completed snapshot databases. Never invokes a legacy store API,
 * follows configured paths, chooses source precedence, or imports grants/proposals.
 * JSON strings remain exact so account IDs cannot be rounded by a projection.
 */
export function readBridgeStoreInventory(files: readonly BridgeStoreFile[], open: (path: string) => Database.Database): BridgeStoreInventory {
  try {
    if (!files.length || files.length > 2 || new Set(files.map(f=>f.name)).size !== files.length
      || new Set(files.map(f=>f.path)).size !== files.length || new Set(files.map(f=>f.kind)).size !== files.length) throw Error();
    const stores: BridgeStoreInventory['stores'] = [];
    for (const file of [...files].sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!['shuttle','runtime'].includes(file.kind) || !file.name || file.name.startsWith('/') || file.name.includes('\\')
        || file.name.split('/').some(p=>!p || p==='.' || p==='..') || basename(file.name) !== `${file.kind}.db`
        || basename(file.path) !== `${file.kind}.db`) throw Error();
      const stat = lstatSync(file.path);
      if (!stat.isFile() || stat.size > 128*1024*1024) throw Error();
      const before = fileDigest(file.path), db = open(file.path);
      let documents: BridgeStoreDocument[], revisions: BridgeStoreRevision[];
      try {
        [documents,revisions] = db.transaction(() => {
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[];
          if (JSON.stringify(tables.map(t=>t.name)) !== '["docs","revisions"]') throw Error();
          for (const table of ['docs','revisions'] as const) {
            const actual = db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[];
            if (JSON.stringify(actual.map(c=>c.name)) !== JSON.stringify(columns[table])) throw Error();
          }
          // Bound SQLite-to-JS materialization BEFORE selecting document words.
          // Length in bytes (BLOB cast), not UTF-8 character count.
          let total = 0n, count = 0n;
          for (const table of ['docs','revisions'] as const) {
            const fields = columns[table].map(c=>`coalesce(length(CAST(${c} AS BLOB)),0)`).join('+');
            const sizes = db.prepare(`SELECT count(*) AS n, coalesce(sum(${fields}),0) AS bytes FROM ${table}`).safeIntegers().get() as {n:bigint;bytes:bigint};
            total += sizes.bytes; count += sizes.n;
          }
          if (total > 8n*1024n*1024n || count > 10000n) throw Error();
          const docs = db.prepare('SELECT collection,key,doc,rev,updated,by FROM docs ORDER BY collection,key').safeIntegers().all() as Record<string,unknown>[];
          const revs = db.prepare('SELECT id,collection,key,doc,rev,op,at,by FROM revisions ORDER BY id').safeIntegers().all() as Record<string,unknown>[];
          const documents = docs.map(r=>({collection:text(r.collection),key:text(r.key),doc:json(r.doc),rev:positive(r.rev),updated:text(r.updated),by:text(r.by)}));
          const revisions = revs.map(r=>({id:positive(r.id),collection:text(r.collection),key:text(r.key),doc:r.doc === null ? null : json(r.doc),rev:positive(r.rev),op:text(r.op),at:text(r.at),by:text(r.by)}));
          if (new Set(documents.map(r=>JSON.stringify([r.collection,r.key]))).size !== documents.length
            || new Set(revisions.map(r=>r.id)).size !== revisions.length) throw Error();
          return [documents,revisions] as const;
        })();
      } finally { db.close(); }
      const after = fileDigest(file.path);
      if (before.sha256 !== after.sha256 || before.bytes !== after.bytes || before.bytes !== stat.size) throw Error();
      stores.push({name:file.name,kind:file.kind,...before,documents,revisions});
    }
    return {stores,checksum:digest(JSON.stringify(stores))};
  } catch { throw Error('Invalid offline Bridges store inventory'); }
}
