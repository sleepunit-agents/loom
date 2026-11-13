/** Private offline archive IO. Each SQLite value is at most one file chunk. */
import { fileChunks, fileDigest } from '../../cli/migration-files.js';
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
  const select=db.prepare('SELECT part,bytes FROM runtime_import_chunks WHERE path=? ORDER BY part');
  let expectedCount=0;
  for(const [path,input] of Object.entries(source.filePaths)) {
    const iterator=select.iterate(path) as IterableIterator<{part:number;bytes:Buffer}>;
    try {
      let part=0;
      for(const chunk of fileChunks(input)) {
        const row=iterator.next();
        if(row.done || row.value.part!==part++ || !Buffer.isBuffer(row.value.bytes) || !chunk.equals(row.value.bytes))return false;
        expectedCount++;
      }
      if(!iterator.next().done)return false;
      const digest=fileDigest(input);
      if(digest.bytes!==source.files[path].bytes || digest.sha256!==source.files[path].sha256)return false;
    } finally {iterator.return?.();}
  }
  return (db.prepare('SELECT count(*) AS n FROM runtime_import_chunks').get() as {n:number}).n===expectedCount;
}
