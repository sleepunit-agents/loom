/** Private holder -> worker transport. Owner configuration supplies both peers'
 * endpoint and pin. secret-command starts this for its original process input;
 * no public daemon door or installed startup activates it. */
import https from 'node:https';
import type { ClientRequest } from 'node:http';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import { chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { certificateFingerprint } from '../pieces/secrets/holder-authority.js';
import { assertPrivateDirectory, privateSocket, tlsMaterial, type LocalHolderConfig } from '../pieces/secrets/local-holder.js';
import { secretInputBindingSchema, type workerSecretInputs, type SecretInputBinding } from './secret-input.js';
const failed=()=>new Error('Worker secret delivery unavailable');
const requestId=z.uuid();


export async function listenWorkerSecretInput(config:Omit<LocalHolderConfig,'servername'>,
  holderFingerprint:string,inputs:ReturnType<typeof workerSecretInputs>) {
  try {
    certificateFingerprint.parse(holderFingerprint);
    if(!isAbsolute(config.socket))throw failed();
    assertPrivateDirectory(dirname(config.socket));
    const material=tlsMaterial(config),active=new Set<Promise<void>>();
    const connections=new WeakMap<object,{expired:boolean;deadline:number}>();
    let closed=false;
    const server=https.createServer({...material,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxHeaderSize:8192},(req,res)=>{
      const work=(async()=>{
        const chunks:Buffer[]=[];let bytes:Buffer|undefined,claim:ReturnType<typeof inputs.claim>=null;
        const peer=req.socket as TLSSocket;
        const connection=connections.get(peer)??connections.get((peer as TLSSocket&{_parent?:object})._parent??{});
        const alive=()=>!!connection&&!connection.expired&&Date.now()<connection.deadline&&!closed&&!res.destroyed;
        res.on('error',()=>{});
        try {
          const match=/^\/v1\/input\/([^/]+)$/.exec(req.url??'');
          const length=req.headers['content-length'],header=req.headers['x-loom-binding'];
          if(!alive()||!peer.authorized||peer.getPeerCertificate().fingerprint256!==holderFingerprint
            ||req.method!=='POST'||!match||!requestId.safeParse(match[1]).success||req.headers['transfer-encoding']
            ||typeof length!=='string'||! /^[1-9][0-9]{0,4}$/.test(length)||Number(length)>65536
            ||typeof header!=='string'||header.length>2048)throw failed();
          const binding=secretInputBindingSchema.parse(JSON.parse(Buffer.from(header,'base64url').toString('utf8')));
          claim=inputs.claim(match[1],binding);
          if(!claim)throw failed();
          let used=0;
          for await(const chunk of req) {
            const b=chunk as Buffer;used+=b.length;
            if(!alive()||used>Number(length)){b.fill(0);throw failed();}
            chunks.push(b);
          }
          if(!alive()||used!==Number(length))throw failed();
          bytes=Buffer.concat(chunks);
          await claim.release(bytes,alive);
          if(!alive())throw failed();
          res.writeHead(204,{'content-length':0,'cache-control':'no-store','connection':'close'});res.end();
        }catch {
          if(!res.headersSent&&!res.destroyed)res.writeHead(503,{'content-length':0,'cache-control':'no-store','connection':'close'});
          res.end();
        }finally {claim?.cancel();bytes?.fill(0);for(const b of chunks)b.fill(0);}
      })();
      active.add(work);void work.catch(()=>{}).finally(()=>active.delete(work));
    });
    server.on('connection',socket=>{
      const state={expired:false,deadline:Date.now()+5000};connections.set(socket,state);
      const timer=setTimeout(()=>{state.expired=true;socket.destroy();},5000);
      socket.once('close',()=>{state.expired=true;clearTimeout(timer);});
    });
    server.requestTimeout=5000;server.headersTimeout=5000;
    try {
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.socket,resolve);});
      chmodSync(config.socket,0o600);
    }catch {server.close();throw failed();}
    let closing:Promise<void>|undefined;
    return {close(){return closing??=(async()=>{
      closed=true;inputs.close();server.closeAllConnections();
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(failed()):resolve()));
      await Promise.all(active);
    })();}};
  }catch {throw failed();}
}

/** Construct only in the holder, from owning runner configuration. Request
 * metadata selects a retained pending handle; it never selects an endpoint. */
export function workerSecretTransport(config:LocalHolderConfig,workerFingerprint:string) {
  try {certificateFingerprint.parse(workerFingerprint);}catch {throw failed();}
  if(!isAbsolute(config.socket)||!config.servername)throw failed();
  const material=tlsMaterial(config),requests=new Set<ClientRequest>();
  let closed=false;
  return {
    async deliver(id:string,binding:SecretInputBinding,bytes:Uint8Array) {
      try {
        if(closed||!requestId.safeParse(id).success||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>65536)throw failed();
        const header=Buffer.from(JSON.stringify(secretInputBindingSchema.parse(binding))).toString('base64url');
        privateSocket(config.socket);
        await new Promise<void>((resolve,reject)=>{
          let settled=false;
          const fail=()=>{if(!settled){settled=true;reject(failed());}};
          const req=https.request({...material,socketPath:config.socket,servername:config.servername,rejectUnauthorized:true,
            checkServerIdentity:(host,cert)=>checkServerIdentity(host,cert)??(cert.fingerprint256===workerFingerprint?undefined:failed()),
            agent:false,minVersion:'TLSv1.3',maxHeaderSize:8192,method:'POST',path:`/v1/input/${id}`,
            headers:{'content-length':bytes.length,'x-loom-binding':header}},res=>{
            const peer=res.socket as TLSSocket;
            if(closed||!peer.authorized||peer.getPeerCertificate().fingerprint256!==workerFingerprint||res.statusCode!==204
              ||res.headers['content-length']!=='0'||res.headers['transfer-encoding']){fail();res.destroy();return;}
            res.on('data',(b:Buffer)=>{b.fill(0);fail();res.destroy();});
            res.on('error',fail);res.on('aborted',fail);
            res.on('end',()=>{if(!settled){settled=true;resolve();}});
          });
          requests.add(req);
          const timer=setTimeout(()=>{fail();req.destroy();},5000);
          req.on('error',fail);req.once('close',()=>{clearTimeout(timer);requests.delete(req);});
          req.end(bytes);
        });
      }catch {throw failed();}
    },
    async close(){closed=true;await Promise.all([...requests].map(req=>new Promise<void>(resolve=>{req.once('close',resolve);req.destroy();})));},
  };
}
