/** Lifetime OS socket ownership; no lock database or mutable app-state file. */
import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function ownHome(home: string): Promise<() => Promise<void>> {
  mkdirSync(home,{recursive:true,mode:0o700});
  const key=createHash('sha256').update(realpathSync(home)).digest('hex').slice(0,32);
  const path=process.platform==='linux'?`\0loom-next-${key}`:process.platform==='win32'?`\\\\.\\pipe\\loom-next-${key}`:join(tmpdir(),`loom-next-${key}.sock`);
  const server=createServer(socket=>socket.end());
  const listen=()=>new Promise<void>((ok,no)=>{const fail=(e:Error)=>{server.off('listening',ready);no(e);};const ready=()=>{server.off('error',fail);ok();};server.once('error',fail);server.once('listening',ready);server.listen(path);});
  try { await listen(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code!=='EADDRINUSE') throw error;
    // Unix filesystem sockets can survive process death; remove only a refused socket.
    if(process.platform!=='linux'&&process.platform!=='win32') {
      const stale=await new Promise<boolean>(done=>{const probe=createConnection(path);probe.once('connect',()=>{probe.destroy();done(false);});probe.once('error',(e:NodeJS.ErrnoException)=>done(e.code==='ECONNREFUSED'));});
      if(stale){try{unlinkSync(path);}catch{} await listen();}
      else throw new Error('loom next is already running for this home');
    } else throw new Error('loom next is already running for this home');
  }
  return ()=>new Promise<void>(ok=>server.close(()=>ok()));
}
