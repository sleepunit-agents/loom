/** Runner-local preparation. Never imported by the daemon: files live in the
 * agent checkout on the worker. Preparation alone authorizes no execution.
 */
import { constants as F, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MAX_BRIEF_FILE = 20_000;
export const MAX_BRIEF_BYTES = 1_048_576;
const path = z.string().max(200).regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .refine(p => p.split('/').every(s => s !== '.' && s !== '..'));
const section = z.union([
  z.object({text:z.string().max(MAX_BRIEF_BYTES)}).strict(),
  z.object({file:path,what:z.string().max(200)}).strict(),
]);
const input = z.object({key:z.string().regex(/^[a-f0-9]{64}$/),
  deny:z.array(z.string().regex(/^[A-Za-z0-9_.*:() -]{1,120}$/)).max(192),
  sections:z.array(section).min(1).max(40),
});
export class RunnerBriefError extends Error {}

function openCheckout(repo:string):number {
  // Do not normalize away a trailing slash or dot component before checking:
  // either can alter the kernel's symlink-following semantics.
  const parts=repo.split('/');
  if(parts.shift()!==''||!parts.length||parts.some(p=>!p||p==='.'||p==='..'))
    throw new RunnerBriefError('Worker checkout needs an absolute path without empty or dot components');
  let dir=openSync('/',F.O_RDONLY|F.O_DIRECTORY|F.O_NOFOLLOW);
  try {
    for(const part of parts) {
      const child=openSync(`/proc/self/fd/${dir}/${part}`,F.O_RDONLY|F.O_DIRECTORY|F.O_NOFOLLOW);
      closeSync(dir);dir=child;
    }
    return dir;
  } catch(error) {closeSync(dir);throw error;}
}

/** Pin every directory descriptor, refusing symlinks at every component.
 * Linux /proc is required; other workers fail closed until given an equivalent
 * descriptor-relative implementation. Never fall back to realpath + path read.
 */
function requiredFile(root:number, relative:string):string {
  const opened:number[]=[];
  try {
    let dir=root;
    const parts=relative.split('/');
    for(const part of parts.slice(0,-1)) {
      dir=openSync(`/proc/self/fd/${dir}/${part}`,F.O_RDONLY|F.O_DIRECTORY|F.O_NOFOLLOW);
      opened.push(dir);
    }
    // NONBLOCK prevents a FIFO from hanging before the regular-file check.
    const fd=openSync(`/proc/self/fd/${dir}/${parts.at(-1)!}`,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK);
    opened.push(fd);
    const before=fstatSync(fd,{bigint:true});
    if(!before.isFile()||before.size>BigInt(MAX_BRIEF_FILE))throw new Error('not a bounded regular file');
    const bytes=Buffer.alloc(MAX_BRIEF_FILE+1);
    let used=0;
    while(used<bytes.length) {
      const count=readSync(fd,bytes,used,bytes.length-used,null);
      if(!count)break;
      used+=count;
    }
    const after=fstatSync(fd,{bigint:true});
    if(used>MAX_BRIEF_FILE||BigInt(used)!==before.size||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs)
      throw new Error('file changed or exceeded bound');
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,used));
    if(!text.trim()||text.includes('\0'))throw new Error('empty or invalid text');
    return text;
  } catch {
    throw new RunnerBriefError(`Required brief file ${JSON.stringify(relative)} is unavailable or unsafe`);
  } finally {
    for(const fd of opened.reverse())closeSync(fd);
  }
}

export interface PreparedRunnerBrief {
  readonly brief:string;
  readonly deny:readonly string[];
  readonly policyKey:string;
  /** Runner-owned history must also match original agent/venue binding. */
  readonly key:string;
}

/** Consume compiler sections in order and retain the exact tool deny list.
 * Required files are never omitted, truncated, or fetched from the daemon.
 * The resolved key includes their bytes; the compiler key alone is insufficient
 * for native-history reuse. This is not a launch or history authorization.
 */
export function prepareRunnerBrief(raw:unknown,repo?:string):PreparedRunnerBrief {
  const parsed=input.safeParse(raw);
  if(!parsed.success)throw new RunnerBriefError('Malformed compiled runner brief');
  const rules=parsed.data;
  let root:number|undefined;
  try {
    if(rules.sections.some(s=>'file' in s)) {
      if(process.platform!=='linux'||!repo)throw new RunnerBriefError('Required brief files need a Linux worker checkout');
      root=openCheckout(repo);
    }
    let size=0;
    const resolved=rules.sections.map(s=>{
      const text='text' in s?s.text:requiredFile(root!,s.file);
      size+=Buffer.byteLength(text);
      if(size>MAX_BRIEF_BYTES)throw new RunnerBriefError('Resolved brief exceeds byte limit');
      return text;
    });
    const key=createHash('sha256').update(JSON.stringify([rules.key,rules.deny,resolved])).digest('hex');
    return Object.freeze({brief:resolved.join(''),deny:Object.freeze([...rules.deny]),policyKey:rules.key,key});
  } catch(error) {
    if(error instanceof RunnerBriefError)throw error;
    throw new RunnerBriefError('Worker checkout is unavailable or unsafe');
  } finally {
    if(root!==undefined)closeSync(root);
  }
}

/** Same descriptor-pinned file reader as required policy sections. Scheduled
 * words are input, never a policy compiler key or a native resume capability. */
export function prepareScheduledFile(file:string,checkout:string):string {
  const parsed=path.safeParse(file);
  if(!parsed.success)throw new RunnerBriefError('Invalid scheduled file path');
  let root:number|undefined;
  try {
    if(process.platform!=='linux')throw new RunnerBriefError('Scheduled files need a Linux worker checkout');
    root=openCheckout(checkout);
    const text=requiredFile(root,parsed.data);
    if(text.includes('<!-- house: local -->'))throw new RunnerBriefError('Scheduled local work requires its own execution boundary');
    return text;
  } catch(error) {
    if(error instanceof RunnerBriefError)throw error;
    throw new RunnerBriefError('Worker checkout is unavailable or unsafe');
  } finally {if(root!==undefined)closeSync(root);}
}
