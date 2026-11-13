/** Bounded offline file IO. Opaque archives and database images never become strings. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, writeSync, fchmodSync } from 'node:fs';
export const migrationChunkBytes = 1024 * 1024;
export function* fileChunks(path: string): Generator<Buffer> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw Error('Migration input must be a regular file');
    const buffer = Buffer.allocUnsafe(migrationChunkBytes);
    while (true) {
      let count=0;
      while(count<buffer.length) {
        const next=readSync(fd,buffer,count,buffer.length-count,null);
        if(!next)break;
        count+=next;
      }
      if(!count)break;
      yield buffer.subarray(0,count);
    }
  } finally { closeSync(fd); }
}
export function fileDigest(path: string): {bytes:number;sha256:string} {
  const hash = createHash('sha256'); let bytes=0;
  for (const chunk of fileChunks(path)) { hash.update(chunk); bytes+=chunk.length; }
  return {bytes,sha256:hash.digest('hex')};
}
export function copyMigrationFile(from:string,to:string):void {
  const fd=openSync(to,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { fchmodSync(fd,0o600); for(const chunk of fileChunks(from)) {
    let offset=0; while(offset<chunk.length)offset+=writeSync(fd,chunk,offset,chunk.length-offset);
  }} finally {closeSync(fd);}
}
