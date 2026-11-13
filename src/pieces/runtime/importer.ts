import { writeRuntimeArchive, compareRuntimeArchive } from './import-archive.js';
/** Explicit offline import only. The daemon never reads old runtime files. */
import type Database from 'better-sqlite3';
import { migrate, type Db } from '../../core/index.js';
import { schema } from './schema/001.js';
import { runtimeImportTables } from './import-projection.js';
import { canonicalRuntimeSource, readRuntimeImport, type RuntimeImportIdentities, type RuntimeImportSources } from './import-source.js';

/** Semantic row comparison preserves every id, count and column without trusting a receipt. */
export function compareRuntimeImport(db: Db, expected: ReturnType<typeof runtimeImportTables>): boolean {
  const normalized = (rows: Record<string,unknown>[]) => canonicalRuntimeSource(rows.map(row=>{
    const copy = {...row}; if (typeof copy.record === 'string') copy.record = JSON.parse(copy.record);
    return canonicalRuntimeSource(copy);
  }).sort());
  return Object.entries(expected).every(([table,rows])=>normalized(db.prepare(`SELECT * FROM ${table}`).all() as Record<string,unknown>[])===normalized(rows));
}
export function importRuntime(db: Db, sources: RuntimeImportSources, options: unknown, identities: RuntimeImportIdentities,
  _now: number, open: (path:string)=>Database.Database, controls: {interrupt?:()=>void; afterSnapshot?:()=>void} = {}) {
  const source = readRuntimeImport(sources,options,identities,open,controls), expected = runtimeImportTables(source);
  return db.transaction(()=>{
    migrate(db,'runtime',schema);
    const before = db.prepare("SELECT value FROM runtime_import_meta WHERE key='source-checksum'").get() as {value:string}|undefined;
    if (before) {
      const mapping = db.prepare("SELECT value FROM runtime_import_meta WHERE key='source-options'").get() as {value:string}|undefined;
      if (before.value!==source.checksum || mapping?.value!==source.options) throw Error('A different runtime source or mapping was already imported');
      return {ok:true,imported:false,checksum:source.checksum};
    }
    for (const table of [...Object.keys(expected),'runtime_import_chunks']) if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw Error('Runtime destination must be empty');
    for (const [table,rows] of Object.entries(expected)) for (const row of rows) {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row) as (string|number)[]);
    }
    writeRuntimeArchive(db,source);
    controls.interrupt?.();
    if (!compareRuntimeImport(db,expected) || !compareRuntimeArchive(db,source)) throw Error('Runtime import ids, counts or content differ');
    return {ok:true,imported:true,checksum:source.checksum};
  })();
}
