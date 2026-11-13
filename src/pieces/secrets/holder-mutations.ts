/** Async holder-only mutation channel, never a synchronous KeyHolder adapter. */
import https from 'node:https';
import { chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { z } from 'zod';
import { assertPrivateDirectory, privateSocket, tlsMaterial, type LocalHolderConfig } from './local-holder.js';
import type { HolderStore, HolderWrite } from './holder-store.js';
import { secretName } from './input.js';

const failed = () => new Error('Local secret mutation unavailable');
const whoSchema = z.object({member:z.string().min(1).max(256),writeId:z.uuid()}).strict();
const limit = 65536;
/** The trusted daemon authenticates the end member and asserts that identity.
 * The holder's authority must pin the permitted daemon certificate fingerprint,
 * resolve the assertion to the actual member and check CURRENT household write
 * permission. Return null on denial. Neither TLS nor this assertion is itself
 * end-member authentication. Never install a pass-through authority.
 */
export type HolderMutationAuthority = (peerFingerprint: string, assertedMember: string) => Promise<string | null>;

export function localHolderMutations(config: LocalHolderConfig) {
  const material = tlsMaterial(config);
  if (!config.servername || !isAbsolute(config.socket)) throw failed();
  async function send(who: HolderWrite, name: string, mode: 'add' | 'replace' | 'remove', value?: Uint8Array) {
    let bytes: Buffer | undefined;
    try {
      who = whoSchema.parse(who); secretName.parse(name);
      if (!['add','replace','remove'].includes(mode)) throw failed();
      if (mode !== 'remove') {
        if (!(value instanceof Uint8Array) || !value.length || value.length > limit) throw failed();
        bytes = Buffer.from(value); // Own a snapshot before any await.
      }
      privateSocket(config.socket);
      await new Promise<void>((resolve,reject) => {
        let settled = false;
        const fail = () => { if (!settled) { settled=true; reject(failed()); } };
        const request = https.request({socketPath:config.socket,servername:config.servername,...material,
          rejectUnauthorized:true,agent:false,minVersion:'TLSv1.3',maxHeaderSize:8192,
          method:'POST',path:`/v1/mutation/${mode}/${name}`,
          headers:{'content-type':'application/octet-stream','content-length':bytes?.length ?? 0,
            'x-holder-member':Buffer.from(who.member).toString('base64url'),'x-holder-write-id':who.writeId},
        },response=>{
          // No holder-controlled output, including an error body, crosses this seam.
          if (response.statusCode!==204 || response.headers['content-length']!=='0' || response.headers['transfer-encoding']) {
            fail();response.destroy();return;
          }
          response.on('data', (chunk:Buffer)=>{chunk.fill(0);fail();response.destroy();});
          response.on('error',fail);response.on('aborted',fail);
          response.on('end',()=>{if (!settled) {settled=true;resolve();}});
        });
        const deadline=setTimeout(()=>{fail();request.destroy();},5000);
        request.on('error',fail);request.on('close',()=>clearTimeout(deadline));
        request.end(bytes);
      });
    } catch { throw failed(); }
    finally { bytes?.fill(0); }
  }
  return {
    set:(who:HolderWrite,name:string,value:Uint8Array,mode:'add'|'replace')=>send(who,name,mode,value),
    remove:(who:HolderWrite,name:string)=>send(who,name,'remove'),
  };
}

/** Separate private socket, no read endpoint. The caller owns store lifetime.
 * Current authorization runs before reading and again immediately before a
 * mutation (including receipt replay). Store work already started may commit
 * after disconnect: retry with the SAME member/writeId/input, never assume a
 * transport failure means rollback. No automatic retries or socket unlinking.
 */
export async function listenHolderMutations(config: Omit<LocalHolderConfig,'servername'>,
  store: Pick<HolderStore,'set'|'remove'>, authority: HolderMutationAuthority) {
  try {
    if (!isAbsolute(config.socket) || typeof authority !== 'function') throw failed();
    assertPrivateDirectory(dirname(config.socket));
    const material=tlsMaterial(config);
    const server=https.createServer({...material,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxHeaderSize:8192},async(req,res)=>{
      const chunks:Buffer[]=[];let bytes:Buffer|undefined;
      let expired=false;
      const deadline=setTimeout(()=>{expired=true;req.destroy();res.destroy();},5000);
      res.on('error',()=>{});
      try {
        const peer=req.socket as TLSSocket;
        const fingerprint=peer.getPeerCertificate().fingerprint256;
        const match=/^\/v1\/mutation\/(add|replace|remove)\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(req.url??'');
        const member=req.headers['x-holder-member'],writeId=req.headers['x-holder-write-id'];
        const length=req.headers['content-length'];
        if (!peer.authorized || !fingerprint || req.method!=='POST' || !match
          || req.headers['content-type']!=='application/octet-stream' || req.headers['transfer-encoding']
          || typeof member!=='string' || !/^[A-Za-z0-9_-]{1,1366}$/.test(member)
          || typeof writeId!=='string' || typeof length!=='string' || !/^(0|[1-9][0-9]{0,4})$/.test(length)) throw failed();
        const asserted=Buffer.from(member,'base64url').toString('utf8');
        if (Buffer.from(asserted).toString('base64url')!==member || asserted.length>256) throw failed();
        const expected=Number(length),mode=match[1] as 'add'|'replace'|'remove',name=match[2];
        if (expected>limit || (mode==='remove' ? expected!==0 : expected===0)) throw failed();
        const memberId=await authority(fingerprint,asserted);
        const who=whoSchema.parse({member:memberId,writeId});
        if (expired || req.destroyed) throw failed();
        let size=0;
        for await (const chunk of req) {
          const b=chunk as Buffer; size+=b.length;
          if (size>expected || expired) { b.fill(0);throw failed(); }
          chunks.push(b);
        }
        if (size!==expected || expired || res.destroyed) throw failed();
        bytes=Buffer.concat(chunks);
        if (await authority(fingerprint,asserted)!==who.member || expired || res.destroyed) throw failed();
        if (mode==='remove') await store.remove(who,name);
        else await store.set(who,name,bytes,mode);
        if (expired || res.destroyed) throw failed();
        res.writeHead(204,{'content-length':0,'cache-control':'no-store'});res.end();
      } catch {
        if (!res.headersSent && !res.destroyed) res.writeHead(503,{'content-length':0,'cache-control':'no-store'});
        res.end();
        // Close unread request input rather than retaining unbounded plaintext.
        if (!req.complete) res.once('finish',()=>req.destroy());
      } finally {clearTimeout(deadline);bytes?.fill(0);for (const b of chunks) b.fill(0);}
    });
    // Enforce the absolute bound from Unix connection acceptance, before TLS or
    // HTTP headers complete. Node's headersTimeout is checked on a coarse timer.
    // Clients use a fresh connection per request; keep-alive never extends this.
    server.on('connection',socket=>{
      const deadline=setTimeout(()=>socket.destroy(),5000);
      socket.once('close',()=>clearTimeout(deadline));
    });
    server.requestTimeout=5000;server.headersTimeout=5000;
    try {
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.socket,resolve);});
      chmodSync(config.socket,0o600);
    } catch {server.close();throw failed();}
    return {async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(failed()):resolve()));}};
  } catch { throw failed(); }
}
