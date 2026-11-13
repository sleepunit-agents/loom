/** Private offline archive IO. Each SQLite value is at most one file chunk. */
import { fileChunks, fileDigest, migrationChunkBytes } from '../../cli/migration-files.js';
import type Database from 'better-sqlite3';
import type { readRuntimeInventory } from './import-source.js';
type Inventory = ReturnType<typeof readRuntimeInventory>;
export function writeRuntimeArchive(db:Database.Database, source:Inventory):void {
  const insert=db.prepare('INSERT INTO runtime_import_chunks(path,part,bytes) VALUES (?,?,?)');
  for(const [path,input] of Object.entries(source.filePaths)) {
    let part=0; for(const chunk of fileChunks(input))insert.run(path,part++,chunk);
  }
}
/** Independent physical byte comparison, including extra/missing/truncated chunks. */
export function compareRuntimeArchive(db:Database.Database, source:Inventory):boolean {
  const select=db.prepare('SELECT part,typeof(bytes) AS kind,length(bytes) AS size FROM runtime_import_chunks WHERE path=? ORDER BY part');
  const bytes=db.prepare('SELECT bytes FROM runtime_import_chunks WHERE path=? AND part=?');
  let expectedCount=0;
  for(const [path,input] of Object.entries(source.filePaths)) {
    const iterator=select.iterate(path) as IterableIterator<{part:number;kind:string;size:number}>;
    try {
      let part=0;
      for(const chunk of fileChunks(input)) {
        const row=iterator.next();
        if(row.done || row.value.part!==part || row.value.kind!=='blob' || row.value.size!==chunk.length || row.value.size>migrationChunkBytes)return false;
        const value=bytes.get(path,part++) as {bytes:Buffer};
        if(!chunk.equals(value.bytes))return false;
        expectedCount++;
      }
      if(!iterator.next().done)return false;
      const digest=fileDigest(input);
      if(digest.bytes!==source.files[path].bytes || digest.sha256!==source.files[path].sha256)return false;
    } finally {iterator.return?.();}
  }
  return (db.prepare('SELECT count(*) AS n FROM runtime_import_chunks').get() as {n:number}).n===expectedCount;
}
