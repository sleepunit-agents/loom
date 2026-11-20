/** Lifetime OS socket ownership; no lock database or mutable app-state file. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function ownHome(home: string): Promise<() => Promise<void>> {
  mkdirSync(home,{recursive:true,mode:0o700});
  const key=createHash('sha256').update(realpathSync(home)).digest('hex').slice(0,32);
  const path=process.platform==='linux'?`\0loom-next-${key}`:process.platform==='win32'?`\\\\.\\pipe\\loom-next-${key}`:join(tmpdir(),`loom-next-${key}.sock`);
  const server=createServer(socket=>socket.destroy());
  const listen=()=>new Promise<void>((ok,no)=>{const fail=(e:Error)=>{server.off('listening',ready);no(e);};const ready=()=>{server.off('error',fail);ok();};server.once('error',fail);server.once('listening',ready);server.listen(path);});
  try { await listen(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code!=='EADDRINUSE') throw error;
    // Never unlink a refused filesystem socket: another contender may have
    // acquired it since our probe. Linux abstract sockets and Windows pipes
    // disappear with the process; other platforms fail closed after a crash.
    throw new Error('loom next is already running for this home (or its OS socket needs cleanup)');
  }
  return ()=>new Promise<void>(ok=>server.close(()=>ok()));
}
