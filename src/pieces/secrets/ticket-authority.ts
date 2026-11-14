/** Private holder -> daemon metadata only. Not registered or activated. */
import https from 'node:https';
import type { ClientRequest } from 'node:http';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import { chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { certificateFingerprint } from './holder-authority.js';
import { assertPrivateDirectory, privateSocket, tlsMaterial, type LocalHolderConfig } from './local-holder.js';
import { secretName } from './input.js';
import type { secretTickets } from './tickets.js';

const failed=()=>new Error('Secret ticket authority unavailable');
const idSchema=z.uuid();
const metadata=z.object({name:secretName,destination:z.object({agent:z.string().min(1).max(100),job:z.uuid(),
  runner:z.string().min(1).max(200),box:z.string().min(1).max(200),claimedAt:z.number().finite(),
  service:z.string().min(1).max(200).optional()}).strict()}).strict();
type Tickets=ReturnType<typeof secretTickets>;
type Claim=NonNullable<ReturnType<Tickets['claim']>>;
/** A remote current() is necessary, not sufficient, for release. The worker
 * transport must authenticate its own pending sink and fence the SAME original
 * destination at the final release boundary. No endpoint comes from this role.
 */
export interface RemoteTicketClaim extends z.infer<typeof metadata> {
  current():Promise<boolean>;
  finish(acknowledged:boolean):Promise<void>;
}

/** Owns original claim closures; restart cannot recreate them from rows. Only
 * the pinned holder may claim/check/finish. Lost claims stay consumed, no retry.
 */
export async function listenTicketAuthority(config:Omit<LocalHolderConfig,'servername'>,
  holderFingerprint:string,tickets:Pick<Tickets,'claim'>) {
  try {
    certificateFingerprint.parse(holderFingerprint);
    if(!isAbsolute(config.socket))throw failed();
    assertPrivateDirectory(dirname(config.socket));
    const material=tlsMaterial(config),claims=new Map<string,Claim>();
    const connections=new WeakMap<object,{expired:boolean;deadline:number}>();
    let closed=false;
    function finish(id:string,ack:boolean) {
      const claim=claims.get(id);claims.delete(id);
      if(!claim)throw failed();
      claim.finish(ack);
    }
    function prune() {
      for(const [id,claim] of claims)if(!claim.current()) {
        try {finish(id,false);}catch { /* already fenced; never recreate */ }
      }
    }
    const server=https.createServer({...material,requestCert:true,rejectUnauthorized:true,
      minVersion:'TLSv1.3',maxHeaderSize:8192},(req,res)=>{
      res.on('error',()=>{});
      try {
        const peer=req.socket as TLSSocket;
        const connection=connections.get(peer)??connections.get((peer as TLSSocket&{_parent?:object})._parent??{});
        if(closed||!connection||connection.expired||Date.now()>=connection.deadline||res.destroyed
          ||!peer.authorized||peer.getPeerCertificate().fingerprint256!==holderFingerprint
          ||req.method!=='POST'||req.headers['content-length']!=='0'||req.headers['transfer-encoding'])throw failed();
        const match=/^\/v1\/tickets\/([^/]+)\/(claim|current|released|uncertain)$/.exec(req.url??'');
        if(!match||!idSchema.safeParse(match[1]).success)throw failed();
        const [,id,action]=match;
        prune();
        let body='';
        if(action==='claim') {
          if(claims.has(id)||claims.size>=1024)throw failed();
          const claim=tickets.claim(id);
          if(!claim)throw failed();
          // Retain before projection, so even a malformed projection burns the
          // durable claim. No error path can call tickets.claim a second time.
          claims.set(id,claim);
          try {
            const d=claim.destination;
            body=JSON.stringify(metadata.parse({name:claim.name,destination:{agent:d.agent,job:d.job,runner:d.runner,
              box:d.box,claimedAt:d.claimedAt,...(d.service===undefined?{}:{service:d.service})}}));
            if(!claim.current())throw failed();
          }catch {finish(id,false);throw failed();}
          res.once('close',()=>{if(!res.writableFinished&&claims.has(id))try {finish(id,false);}catch {}});
        }else if(action==='current') {
          if(!claims.get(id)?.current())throw failed();
        }else {
          if(!claims.has(id))throw failed();
          finish(id,action==='released');
        }
        res.writeHead(body?200:204,{'content-length':Buffer.byteLength(body),'cache-control':'no-store',
          'content-type':'application/json','connection':'close'});res.end(body);
      }catch {
        if(!res.headersSent&&!res.destroyed)res.writeHead(503,{'content-length':0,'cache-control':'no-store','connection':'close'});
        res.end();
      }
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
    return {close() {
      if(closing)return closing;
      closed=true;
      for(const id of claims.keys())try {finish(id,false);}catch {}
      server.closeAllConnections();
      return closing=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(failed()):resolve()));
    }};
  }catch {throw failed();}
}

/** Pinned holder client. Receives bounded identity metadata only. It never
 * exposes response/provider diagnostics and never retries an uncertain call.
 */
export function remoteTicketAuthority(config:LocalHolderConfig,daemonFingerprint:string) {
  try {certificateFingerprint.parse(daemonFingerprint);}catch {throw failed();}
  if(!isAbsolute(config.socket)||!config.servername)throw failed();
  const material=tlsMaterial(config),requests=new Set<ClientRequest>();
  let closed=false;
  async function call(id:string,action:'claim'|'current'|'released'|'uncertain'):Promise<string> {
    try {
      if(closed||!idSchema.safeParse(id).success)throw failed();
      privateSocket(config.socket);
      return await new Promise<string>((resolve,reject)=>{
        let settled=false;
        const fail=()=>{if(!settled){settled=true;reject(failed());}};
        const req=https.request({...material,socketPath:config.socket,servername:config.servername,rejectUnauthorized:true,
          checkServerIdentity:(host,cert)=>checkServerIdentity(host,cert)??(cert.fingerprint256===daemonFingerprint?undefined:failed()),
          agent:false,minVersion:'TLSv1.3',maxHeaderSize:8192,method:'POST',path:`/v1/tickets/${id}/${action}`,
          headers:{'content-length':0}},res=>{
          const peer=res.socket as TLSSocket;
          const length=res.headers['content-length'];
          if(closed||!peer.authorized||peer.getPeerCertificate().fingerprint256!==daemonFingerprint
            ||res.statusCode!==(action==='claim'?200:204)||typeof length!=='string'||! /^(0|[1-9][0-9]{0,3})$/.test(length)
            ||Number(length)>2048||(action!=='claim'&&length!=='0')||res.headers['transfer-encoding']) {
            fail();res.destroy();return;
          }
          const chunks:Buffer[]=[];let used=0;
          res.on('data',(bytes:Buffer)=>{
            used+=bytes.length;
            if(used>Number(length)){bytes.fill(0);fail();res.destroy();return;}
            chunks.push(Buffer.from(bytes));
          });
          res.on('error',fail);res.on('aborted',fail);
          res.on('end',()=>{
            if(settled)return;
            if(closed||used!==Number(length)){fail();return;}
            settled=true;resolve(Buffer.concat(chunks).toString('utf8'));
          });
        });
        requests.add(req);
        const timer=setTimeout(()=>{fail();req.destroy();},5000);
        req.on('error',fail);req.once('close',()=>{clearTimeout(timer);requests.delete(req);});req.end();
      });
    }catch {throw failed();}
  }
  return {
    async claim(id:string):Promise<RemoteTicketClaim|null> {
      try {
        const value=metadata.parse(JSON.parse(await call(id,'claim')));
        let settled=false,invalid=false;
        return Object.freeze({...value,destination:Object.freeze(value.destination),
          async current() {
            if(settled||invalid||closed)return false;
            try {await call(id,'current');return !settled&&!invalid&&!closed;}
            catch {invalid=true;return false;}
          },
          async finish(acknowledged:boolean) {
            if(settled)throw failed();
            settled=true;
            await call(id,acknowledged===true&&!invalid?'released':'uncertain');
          },
        });
      }catch {return null;}
    },
    async close() {
      closed=true;
      await Promise.all([...requests].map(req=>new Promise<void>(resolve=>{req.once('close',resolve);req.destroy();})));
    },
  };
}
