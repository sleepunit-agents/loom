import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link, lstat, mkdir, open, realpath, unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import {machineName} from '../core/line-name.js';
import {privateOrigin} from '../core/private-origin.js';

const identity = z.object({
  origin:z.string(), name:machineName, request:z.uuid(), token:z.string().regex(/^loom_[A-Za-z0-9_-]{43}$/),
}).strict();

function hasCode(error:unknown, code:string) {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Keep the first complete identity across retries, including two processes starting together. */
async function joinIdentity(directory:string, origin:string, name:string) {
  const root=resolve(directory);
  await mkdir(root,{mode:0o700,recursive:true});
  const stat=await lstat(root);
  if(!stat.isDirectory() || await realpath(root)!==root || stat.uid!==process.getuid?.() || (stat.mode&0o077))
    throw Error('Choose a private directory owned by the worker');
  const file=join(root,'worker-join.json');
  async function load(){
    const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const info=await handle.stat();
      if(!info.isFile() || info.uid!==stat.uid || (info.mode&0o077) || info.size>4096)throw Error('Invalid join file');
      const saved=identity.parse(JSON.parse(await handle.readFile('utf8')));
      if(saved.origin!==origin || saved.name!==name)throw Error('Join already belongs to a different machine or Loom');
      return saved;
    }finally{await handle.close();}
  }
  try{return await load();}catch(error){if(!hasCode(error,'ENOENT'))throw error;}
  const pending=join(root,'.join-'+randomUUID());
  const handle=await open(pending,'wx',0o600);
  try{
    try{
      await handle.writeFile(JSON.stringify({origin,name,request:randomUUID(),token:'loom_'+randomBytes(32).toString('base64url')}));
      await handle.sync();
    }finally{await handle.close();}
    try{await link(pending,file);}catch(error){if(!hasCode(error,'EEXIST'))throw error;}
    const parent=await open(root,'r');
    try{await parent.sync();}finally{await parent.close();}
  }finally{await unlink(pending);}
  return load();
}

/** The worker keeps its own credential. Loom receives only its fingerprint and the request identity. */
export async function requestWorkerJoin(address:string, name:string, directory:string){
  const origin=privateOrigin(address).origin;
  machineName.parse(name);
  const saved=await joinIdentity(directory,origin,name);
  const fingerprint=createHash('sha256').update(saved.token).digest('hex');
  const response=await fetch(origin+'/api/worker-join/request',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
    headers:{'content-type':'application/json'},body:JSON.stringify({request:saved.request,name,fingerprint}),
  });
  if(!response.ok)throw Error('Loom did not accept the join request');
  const result=z.discriminatedUnion('state',[
    z.object({state:z.literal('pending'),code:z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)}),
    z.object({state:z.literal('allowed'),box:z.string().regex(/^box-[a-f0-9-]{36}$/)}),
    z.object({state:z.literal('blocked')}),z.object({state:z.literal('expired')}),
  ]).parse(await response.json());
  return result;
}
