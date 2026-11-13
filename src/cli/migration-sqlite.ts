import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { copyMigrationFile } from './migration-files.js';
/** Completed backups only. A private disk image avoids source sidecars and whole-DB buffers. */
export function openSnapshotSqlite(path: string): Database.Database {
  const directory=mkdtempSync(join(tmpdir(),'loom-migration-sqlite-'));
  try {
    const image=join(directory,'snapshot.db');copyMigrationFile(path,image);
    const fd=openSync(image,'r+');
    try {
      const header=Buffer.alloc(20); const size=readSync(fd,header,0,20,0);
      if(size!==20 || header.subarray(0,16).toString()!=='SQLite format 3\0')throw Error('Invalid SQLite snapshot');
      // Normalize only the disposable image, never a live WAL or source bytes.
      writeSync(fd,Buffer.from([1,1]),0,2,18);
    } finally {closeSync(fd);}
    const db=new Database(image,{readonly:true,fileMustExist:true});
    const close=db.close.bind(db);
    db.close=()=>{try{return close();}finally{rmSync(directory,{recursive:true,force:true});}};
    return db;
  } catch(error) {rmSync(directory,{recursive:true,force:true});throw error;}
}
