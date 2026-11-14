/** Worker-local evidence only. No receipt is execution, resume or absence proof. */
import { constants as F, openSync, closeSync, fstatSync, fsyncSync, writeSync, readSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const receiptPhases = ['reserved', 'claim-attempt', 'claimed', 'input-attempt', 'input-received',
  'launch-attempt', 'spawned', 'running-attempt', 'running', 'output-returned', 'finish-attempt', 'finished'] as const;
type Phase = typeof receiptPhases[number];
const row = z.object({ v:z.literal(1), job:z.string().min(1).max(200), attempt:z.uuid(), phase:z.enum(receiptPhases) }).strict();
export type WorkerReceipt = z.infer<typeof row>;
const failed = () => new Error('Worker receipts unavailable; reconcile before retrying');
const receiptFilename = (job:string) => `${createHash('sha256').update(job).digest('hex')}.jsonl`;

/** Pin all ancestors, refusing aliases. Owner prepares a dedicated 0700 directory.
 * Linux /proc is required; never fall back to a path check followed by a reopen. */
function directory(path:string):number {
  const parts=path.split('/');
  if(process.platform!=='linux'||parts.shift()!==''||!parts.length||parts.some(p=>!p||p==='.'||p==='..'))throw failed();
  let fd=openSync('/',F.O_RDONLY|F.O_DIRECTORY|F.O_NOFOLLOW);
  try {
    for(const part of parts) {
      const child=openSync(`/proc/self/fd/${fd}/${part}`,F.O_RDONLY|F.O_DIRECTORY|F.O_NOFOLLOW);
      closeSync(fd);fd=child;
    }
    const stat=fstatSync(fd);
    if(stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o700)throw failed();
    return fd;
  }catch {closeSync(fd);throw failed();}
}

/** Exclusive reservation survives restart and concurrent workers. Never delete or
 * overwrite it, even on preflight failure. Empty/torn files also block reuse.
 * Each intent is fsynced BEFORE its outside action; acknowledgements AFTER it.
 * A failed write permanently closes this writer and prevents any later action. */
export function reserveWorkerReceipt(path:string,job:string) {
  const identity=row.pick({job:true}).parse({job}),attempt=randomUUID();
  let dir:number|undefined,file:number|undefined,closed=false,next=0;
  const close=()=>{
    closed=true;
    const f=file,d=dir;file=undefined;dir=undefined;
    try {if(f!==undefined)closeSync(f);}finally {if(d!==undefined)closeSync(d);}
  };
  const advance=(phase:Phase)=>{
    if(closed||phase!==receiptPhases[next])throw failed();
    try {
      const bytes=Buffer.from(JSON.stringify({v:1,...identity,attempt,phase})+'\n');
      let used=0;
      while(used<bytes.length) {
        const count=writeSync(file!,bytes,used,bytes.length-used);
        if(count<=0)throw failed();
        used+=count;
      }
      fsyncSync(file!);next++;
    }catch {try {close();}catch { /* keep the original uncertainty */ }throw failed();}
  };
  try {
    dir=directory(path);
    file=openSync(`/proc/self/fd/${dir}/${receiptFilename(job)}`,F.O_WRONLY|F.O_CREAT|F.O_EXCL|F.O_NOFOLLOW|F.O_APPEND,0o600);
    advance('reserved');
    fsyncSync(dir);
    return Object.freeze({advance,close});
  }catch {try {close();}catch { /* a reservation is never removed */ }throw failed();}
}

/** Read-only inventory, never a recovery/adoption decision. Complete means only
 * that finishJob was acknowledged; it says nothing about native collection.
 * Refuse malformed, partial, aliased or oversized evidence as a whole. */
export function inspectWorkerReceipts(path:string):WorkerReceipt[] {
  const dir=directory(path);
  try {
    const entries=readdirSync(`/proc/self/fd/${dir}`);
    if(entries.length>10_000)throw failed();
    return entries.sort().map(entry=>{
      if(!/^[a-f0-9]{64}\.jsonl$/.test(entry))throw failed();
      const fd=openSync(`/proc/self/fd/${dir}/${entry}`,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK);
      try {
        const before=fstatSync(fd,{bigint:true});
        if(!before.isFile()||before.nlink!==1n||before.uid!==BigInt(process.getuid!())||(before.mode&0o777n)!==0o600n||before.size>16_384n)throw failed();
        const bytes=Buffer.alloc(16_385);let used=0;
        while(used<bytes.length) {const count=readSync(fd,bytes,used,bytes.length-used,null);if(!count)break;used+=count;}
        const after=fstatSync(fd,{bigint:true});
        if(used>16_384||BigInt(used)!==before.size||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs)throw failed();
        const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used));
        if(!text.endsWith('\n'))throw failed();
        const rows=text.slice(0,-1).split('\n').map(line=>row.parse(JSON.parse(line)));
        if(!rows.length||rows.length>receiptPhases.length||rows.some((r,i)=>r.phase!==receiptPhases[i]
          ||r.job!==rows[0].job||r.attempt!==rows[0].attempt)||receiptFilename(rows[0].job)!==entry)throw failed();
        return rows.at(-1)!;
      }finally {closeSync(fd);}
    });
  }catch {throw failed();}
  finally {closeSync(dir);}
}
