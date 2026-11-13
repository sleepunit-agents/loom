/** Dedicated holder -> daemon authorization channel. No value or public API. */
import https from 'node:https';
import { chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { z } from 'zod';
import { assertPrivateDirectory, privateSocket, tlsMaterial, type LocalHolderConfig } from './local-holder.js';
import type { HolderMutationAuthority } from './holder-mutations.js';

export const certificateFingerprint = z.string().regex(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
export const holderTls = z.object({socket:z.string().refine(isAbsolute),ca:z.string().refine(isAbsolute),
  cert:z.string().refine(isAbsolute),key:z.string().refine(isAbsolute)}).strict();
export const authorityServerConfig = holderTls.extend({holderFingerprint:certificateFingerprint});
export type AuthorityServerConfig = z.infer<typeof authorityServerConfig>;
const memberSchema = z.string().min(1).max(256);
const failed = () => new Error('Secret holder authority unavailable');

/** TLS pins the holder; currentMember must consult current central membership
 * and household permission on each call. No cached permission or shared agent. */
export async function listenHolderAuthority(raw: AuthorityServerConfig, currentMember: (member:string)=>boolean) {
  try {
    const config=authorityServerConfig.parse(raw);
    assertPrivateDirectory(dirname(config.socket));
    const material=tlsMaterial(config);
    const server=https.createServer({...material,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxHeaderSize:8192},(req,res)=>{
      res.on('error',()=>{});
      let allowed=false;
      try {
        const peer=req.socket as TLSSocket, encoded=req.headers['x-holder-member'];
        if (!peer.authorized || peer.getPeerCertificate().fingerprint256!==config.holderFingerprint
          || req.method!=='POST' || req.url!=='/v1/authority' || req.headers['content-length']!=='0'
          || req.headers['transfer-encoding'] || typeof encoded!=='string' || !/^[A-Za-z0-9_-]{1,1366}$/.test(encoded)) throw failed();
        const member=memberSchema.parse(Buffer.from(encoded,'base64url').toString('utf8'));
        if (Buffer.from(member).toString('base64url')!==encoded) throw failed();
        allowed=currentMember(member)===true;
      } catch { /* Fixed empty denial, no database/provider error crosses TLS. */ }
      res.writeHead(allowed?204:503,{'content-length':0,'cache-control':'no-store','connection':'close'});res.end();
    });
    server.on('connection',socket=>{const timer=setTimeout(()=>socket.destroy(),5000);socket.once('close',()=>clearTimeout(timer));});
    server.requestTimeout=5000;server.headersTimeout=5000;
    try {await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.socket,resolve);});chmodSync(config.socket,0o600);}
    catch {server.close();throw failed();}
    return {async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(failed()):resolve()));}};
  } catch {throw failed();}
}

/** Only the pinned daemon may assert a member. The separate daemon's pinned
 * server then checks that exact actual member against its current database. */
export function remoteHolderAuthority(config: LocalHolderConfig, daemonFingerprint: string): HolderMutationAuthority {
  certificateFingerprint.parse(daemonFingerprint);
  const material=tlsMaterial(config);
  return async (peer,member) => {
    if (peer!==daemonFingerprint || !memberSchema.safeParse(member).success) return null;
    try {
      privateSocket(config.socket);
      return await new Promise<string|null>(resolve=>{
        let settled=false;
        const finish=(allowed=false)=>{if(!settled){settled=true;resolve(allowed?member:null);}};
        const req=https.request({socketPath:config.socket,servername:config.servername,...material,rejectUnauthorized:true,
          agent:false,minVersion:'TLSv1.3',maxHeaderSize:8192,method:'POST',path:'/v1/authority',
          headers:{'content-length':0,'x-holder-member':Buffer.from(member).toString('base64url')},
        },res=>{
          // A CA peer with another identity must not impersonate the authority.
          const socket=res.socket as TLSSocket;
          if (socket.getPeerCertificate().fingerprint256!==daemonFingerprint || res.statusCode!==204
            || res.headers['content-length']!=='0' || res.headers['transfer-encoding']) {finish();res.destroy();return;}
          res.on('data',(b:Buffer)=>{b.fill(0);finish();res.destroy();});
          res.on('error',()=>finish());res.on('aborted',()=>finish());res.on('end',()=>finish(true));
        });
        const timer=setTimeout(()=>{finish();req.destroy();},5000);
        req.on('close',()=>clearTimeout(timer));req.on('error',()=>finish());req.end();
      });
    } catch {return null;}
  };
}
