/** Async holder-only mutation channel, never a synchronous KeyHolder adapter. */
import https from 'node:https';
import type {ClientRequest} from 'node:http';
import { chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { z } from 'zod';
import { assertPrivateDirectory, privateSocket, tlsMaterial, type LocalHolderConfig } from './local-holder.js';
import type { HolderStore, HolderWrite } from './holder-store.js';
import { secretName } from './input.js';
import { synchronousHolderAcknowledgement } from './keyholder.js';

const failed = () => new Error('Local secret mutation unavailable');
const whoSchema = z.object({member:z.string().min(1).max(256),writeId:z.uuid()}).strict();
const limit = 65536;
/** Authenticate the pinned installed daemon and canonicalize its actor assertion.
 * The outside root authorizes the owner BEFORE admitting a journal write. The
 * private holder is installed trusted code, not another owner-permission door.
 * Recovery must remain available for admitted actors after their role changes;
 * it releases no value and can only confirm a commit or fence an unused id.
 * Never expose this transport or its daemon key to an outside caller.
 */
export type HolderMutationAuthority = (peerFingerprint: string, assertedMember: string) => Promise<string | null>;

export function localHolderMutations(config: LocalHolderConfig) {
  const material = tlsMaterial(config);
  let closed = false;
  const requests = new Set<ClientRequest>();
  if (!config.servername || !isAbsolute(config.socket)) throw failed();
  async function send(who: HolderWrite, name: string | undefined, mode: 'add' | 'replace' | 'remove' | 'receipt' | 'recover', value?: Uint8Array) {
    let bytes: Buffer | undefined;
    try {
      if (closed) throw failed();
      who = whoSchema.parse(who); if (mode !== 'receipt' && mode !== 'recover') secretName.parse(name);
      if (!['add','replace','remove','receipt','recover'].includes(mode)) throw failed();
      if (mode !== 'remove' && mode !== 'receipt' && mode !== 'recover') {
        if (!(value instanceof Uint8Array) || !value.length || value.length > limit) throw failed();
        bytes = Buffer.from(value); // Own a snapshot before any await.
      }
      privateSocket(config.socket);
      return await new Promise<boolean>((resolve,reject) => {
        let settled = false;
        const fail = () => { if (!settled) { settled=true; reject(failed()); } };
        const request = https.request({socketPath:config.socket,servername:config.servername,...material,
          rejectUnauthorized:true,agent:false,minVersion:'TLSv1.3',maxHeaderSize:8192,
          method:'POST',path:mode === 'receipt' ? '/v1/receipt' : mode === 'recover' ? '/v1/recover' : `/v1/mutation/${mode}/${name}`,
          headers:{'content-type':'application/octet-stream','content-length':bytes?.length ?? 0,
            'x-holder-member':Buffer.from(who.member).toString('base64url'),'x-holder-write-id':who.writeId},
        },response=>{
          // No holder-controlled output, including an error body, crosses this seam.
          if ((response.statusCode!==204 && !(mode==='receipt' && response.statusCode===404) && !(mode==='recover' && response.statusCode===410)) || response.headers['content-length']!=='0' || response.headers['transfer-encoding']) {
            fail();response.destroy();return;
          }
          response.on('data', (chunk:Buffer)=>{chunk.fill(0);fail();response.destroy();});
          response.on('error',fail);response.on('aborted',fail);
          response.on('end',()=>{if (!settled) {settled=true;resolve(response.statusCode===204);}});
        });
        requests.add(request);
        request.once('close',()=>requests.delete(request));
        const deadline=setTimeout(()=>{fail();request.destroy();},5000);
        request.on('error',fail);request.on('close',()=>clearTimeout(deadline));
        request.end(bytes);
      });
    } catch { throw failed(); }
    finally { bytes?.fill(0); }
  }
  return {
    async close() {
      closed = true;
      await Promise.all([...requests].map(request=>new Promise<void>(resolve=>{request.once('close',resolve);request.destroy();})));
    },
    set:async(who:HolderWrite,name:string,value:Uint8Array,mode:'add'|'replace')=>{await send(who,name,mode,value);},
    remove:async(who:HolderWrite,name:string)=>{await send(who,name,'remove');},
    /** A positive answer confirms a committed member/id, not the caller's input.
     * A negative answer must never release a reservation or trigger another id. */
    hasReceipt:(who:HolderWrite)=>send(who,undefined,'receipt'),
    recover:async(who:HolderWrite):Promise<'committed'|'undone'> => await send(who,undefined,'recover') ? 'committed' : 'undone',
  };
}

/** Separate private socket, no value read endpoint. The caller owns store lifetime.
 * Current daemon authentication runs before reading and again immediately before a
 * mutation (including receipt replay). Store work already started may commit
 * after disconnect: retry with the SAME member/writeId/input, never assume a
 * transport failure means rollback. No automatic retries or socket unlinking.
 */
export async function listenHolderMutations(config: Omit<LocalHolderConfig,'servername'>,
  store: Pick<HolderStore,'set'|'remove'|'hasReceipt'|'recover'>, authority: HolderMutationAuthority) {
  try {
    if (!isAbsolute(config.socket) || typeof authority !== 'function') throw failed();
    assertPrivateDirectory(dirname(config.socket));
    const material=tlsMaterial(config);
    const active=new Set<Promise<void>>();let closed=false;
    const server=https.createServer({...material,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxHeaderSize:8192},(req,res)=>{
      const work=(async()=>{
      const chunks:Buffer[]=[];let bytes:Buffer|undefined;
      let expired=false;
      const deadline=setTimeout(()=>{expired=true;req.destroy();res.destroy();},5000);
      res.on('error',()=>{});
      try {
        const peer=req.socket as TLSSocket;
        const fingerprint=peer.getPeerCertificate().fingerprint256;
        const receipt=req.url==='/v1/receipt', recovery=req.url==='/v1/recover';
        const match=/^\/v1\/mutation\/(add|replace|remove)\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(req.url??'');
        const member=req.headers['x-holder-member'],writeId=req.headers['x-holder-write-id'];
        const length=req.headers['content-length'];
        if (closed || !peer.authorized || !fingerprint || req.method!=='POST' || (!match && !receipt && !recovery)
          || req.headers['content-type']!=='application/octet-stream' || req.headers['transfer-encoding']
          || typeof member!=='string' || !/^[A-Za-z0-9_-]{1,1366}$/.test(member)
          || typeof writeId!=='string' || typeof length!=='string' || !/^(0|[1-9][0-9]{0,4})$/.test(length)) throw failed();
        const asserted=Buffer.from(member,'base64url').toString('utf8');
        if (Buffer.from(asserted).toString('base64url')!==member || asserted.length>256) throw failed();
        const expected=Number(length),mode=receipt ? 'receipt' : recovery ? 'recover' : match![1] as 'add'|'replace'|'remove',name=match?.[2];
        if (expected>limit || (mode==='remove' || mode==='receipt' || mode==='recover' ? expected!==0 : expected===0)) throw failed();
        const memberId=await authority(fingerprint,asserted);
        const who=whoSchema.parse({member:memberId,writeId});
        if (closed || expired || req.destroyed) throw failed();
        let size=0;
        for await (const chunk of req) {
          const b=chunk as Buffer; size+=b.length;
          if (size>expected || expired) { b.fill(0);throw failed(); }
          chunks.push(b);
        }
        if (closed || size!==expected || expired || res.destroyed) throw failed();
        bytes=Buffer.concat(chunks);
        if (await authority(fingerprint,asserted)!==who.member || closed || expired || res.destroyed) throw failed();
        let committed=true, undone=false;
        if (mode==='receipt') {
          const found:unknown=store.hasReceipt(who);
          // Consume accidental async rejection as well as refusing its evidence.
          synchronousHolderAcknowledgement(found);
          if (typeof found!=='boolean') throw failed();
          committed=found;
          if (await authority(fingerprint,asserted)!==who.member) throw failed();
        } else if (mode==='recover') {
          const outcome:unknown=store.recover(who);
          synchronousHolderAcknowledgement(outcome);
          if (outcome!=='committed' && outcome!=='undone') throw failed();
          committed=outcome==='committed';undone=outcome==='undone';
          if (await authority(fingerprint,asserted)!==who.member) throw failed();
        } else if (mode==='remove') await store.remove(who,name!);
        else await store.set(who,name!,bytes,mode);
        if (closed || expired || res.destroyed) throw failed();
        res.writeHead(undone?410:committed?204:404,{'content-length':0,'cache-control':'no-store'});res.end();
      } catch {
        if (!res.headersSent && !res.destroyed) res.writeHead(503,{'content-length':0,'cache-control':'no-store'});
        res.end();
        // Close unread request input rather than retaining unbounded plaintext.
        if (!req.complete) res.once('finish',()=>req.destroy());
      } finally {clearTimeout(deadline);bytes?.fill(0);for (const b of chunks) b.fill(0);}
      })();
      active.add(work);void work.catch(()=>{}).finally(()=>active.delete(work));
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
    let closing:Promise<void>|undefined;
    return {close(){return closing??=(async()=>{
      closed=true;server.closeAllConnections();
      try {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(failed()):resolve()));}
      finally {await Promise.allSettled(active);}
    })();}};
  } catch { throw failed(); }
}
