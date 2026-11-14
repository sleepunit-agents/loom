/** Owner-only worker admission. Metadata headers only; no public registration.
 * The authenticated configured peer supplies a pending id, never an assignment,
 * viewer, holder, endpoint or proof. Restart cannot recover these capabilities. */
import https from 'node:https';
import type {ClientRequest} from 'node:http';
import {checkServerIdentity,type TLSSocket} from 'node:tls';
import {chmodSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {z} from 'zod';
import type {Viewer} from '../../core/index.js';
import {certificateFingerprint} from './holder-authority.js';
import {assertPrivateDirectory,privateSocket,tlsMaterial,type LocalHolderConfig} from './local-holder.js';
import {authenticatedHolderDispatch,type localHolderHandoff} from './holder-handoff.js';
import {secretInputBindingSchema,type SecretInputBinding} from './worker-binding.js';
import {secretName} from './input.js';
import type {secretTickets} from './tickets.js';
const failed=()=>new Error('Worker admission unavailable');
const idSchema=z.uuid();
const replySchema=z.object({id:idSchema,pendingId:idSchema}).strict();
export interface AdmissionWorker {
  fingerprint:string; binding:SecretInputBinding; viewer:Viewer;
  holder:ReturnType<typeof localHolderHandoff>;
}

export async function listenWorkerAdmission(config:Omit<LocalHolderConfig,'servername'>,
  tickets:ReturnType<typeof secretTickets>,workers:readonly AdmissionWorker[]) {
  try {
    config={...config};
    // Snapshot original owner configuration before the first await. Retain the
    // ORIGINAL authenticated viewer: a copy loses Signin capability provenance.
    if(!isAbsolute(config.socket)||workers.length>1024)throw failed();
    assertPrivateDirectory(dirname(config.socket));
    const peers=workers.map(w=>{
      authenticatedHolderDispatch(w.holder);
      return {fingerprint:certificateFingerprint.parse(w.fingerprint),binding:secretInputBindingSchema.parse(w.binding),
        viewer:w.viewer,holder:w.holder};
    });
    if(new Set(peers.map(w=>w.fingerprint)).size!==peers.length)throw failed();
    const material=tlsMaterial(config);
    type Admission=ReturnType<typeof tickets.admitHandoff>;
    const retained=new Map<string,{peer:typeof peers[number];admission:Admission;ready:boolean;timer:ReturnType<typeof setTimeout>}>();
    const connections=new WeakMap<object,{expired:boolean;deadline:number}>();
    const active=new Set<Promise<void>>();let closed=false;
    const retire=(pendingId:string)=>{
      const entry=retained.get(pendingId);if(!entry)return;
      retained.delete(pendingId);clearTimeout(entry.timer);entry.admission.abandon();
    };
    const server=https.createServer({...material,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxHeaderSize:8192},(req,res)=>{
      const work=(async()=>{
        res.on('error',()=>{});
        try {
          const socket=req.socket as TLSSocket;
          const connection=connections.get(socket)??connections.get((socket as TLSSocket&{_parent?:object})._parent??{});
          const alive=()=>!closed&&!!connection&&!connection.expired&&Date.now()<connection.deadline&&!res.destroyed;
          const peer=peers.find(w=>w.fingerprint===socket.getPeerCertificate().fingerprint256);
          const match=/^\/v1\/admission\/([^/]+)\/(admit|dispatch|cancel)$/.exec(req.url??'');
          if(!alive()||!socket.authorized||!peer||!match||req.method!=='POST'
            ||req.headers['content-length']!=='0'||req.headers['transfer-encoding'])throw failed();
          const pendingId=idSchema.parse(match[1]),action=match[2];
          let body='';
          if(action==='admit') {
            const name=secretName.parse(req.headers['x-loom-name']);
            if(retained.has(pendingId)||retained.size>=1024||req.headers['x-loom-ticket'])throw failed();
            const admission=tickets.admitHandoff(peer.viewer,name,{id:pendingId,binding:peer.binding},peer.holder);
            const timer=setTimeout(()=>retire(pendingId),30_000);
            retained.set(pendingId,{peer,admission,ready:false,timer});
            res.once('close',()=>{if(!res.writableFinished)retire(pendingId);});
            body=JSON.stringify({id:admission.id,pendingId});
          }else {
            const entry=retained.get(pendingId);
            if(!entry||entry.peer!==peer||req.headers['x-loom-ticket']!==entry.admission.id||req.headers['x-loom-name'])throw failed();
            if(action==='cancel')retire(pendingId);
            else {
              // Reject a duplicate before its finally can retire the first dispatch.
              if(entry.ready)throw failed();entry.ready=true;
              res.once('close',()=>{if(!res.writableFinished)retire(pendingId);});
              try {await entry.admission.dispatch();if(!alive())throw failed();}
              finally {retire(pendingId);}
            }
          }
          if(!alive())throw failed();
          res.writeHead(body?200:204,{'content-length':Buffer.byteLength(body),'cache-control':'no-store','connection':'close'});res.end(body);
        }catch {
          if(!res.headersSent&&!res.destroyed)res.writeHead(503,{'content-length':0,'cache-control':'no-store','connection':'close'});
          res.end();
        }
      })();
      active.add(work);void work.catch(()=>{}).finally(()=>active.delete(work));
    });
    server.on('connection',socket=>{
      const state={expired:false,deadline:Date.now()+5000};connections.set(socket,state);
      const timer=setTimeout(()=>{state.expired=true;socket.destroy();},5000);
      socket.once('close',()=>{state.expired=true;clearTimeout(timer);});
    });
    server.requestTimeout=5000;server.headersTimeout=5000;
    try {await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.socket,resolve);});chmodSync(config.socket,0o600);}
    catch {server.close();throw failed();}
    let closing:Promise<void>|undefined;
    return {close(){return closing??=(async()=>{
      closed=true;for(const pendingId of retained.keys())retire(pendingId);
      server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(failed()):resolve()));
      await Promise.all(active);
    })();}};
  }catch {throw failed();}
}

/** One original pending identity per pinned client. No retries or re-admission. */
export function workerAdmission(config:LocalHolderConfig,daemonFingerprint:string,pendingId:string) {
  try {
    config={...config};idSchema.parse(pendingId);certificateFingerprint.parse(daemonFingerprint);
    if(!isAbsolute(config.socket)||!config.servername)throw failed();
    const material=tlsMaterial(config),requests=new Set<ClientRequest>();
    let closed=false,stopping=false,attempted=false,dispatched=false,delivered=false,ticketId:string|undefined;
    let closing:Promise<void>|undefined;
    async function call(action:'admit'|'dispatch'|'cancel',name?:string) {
      try {
        if(closed||(stopping&&action!=='cancel'))throw failed();privateSocket(config.socket);
        return await new Promise<string>((resolve,reject)=>{
          let settled=false;const fail=()=>{if(!settled){settled=true;reject(failed());}};
          const req=https.request({...material,socketPath:config.socket,servername:config.servername,rejectUnauthorized:true,
            checkServerIdentity:(host,cert)=>checkServerIdentity(host,cert)??(cert.fingerprint256===daemonFingerprint?undefined:failed()),
            agent:false,minVersion:'TLSv1.3',maxHeaderSize:8192,method:'POST',path:`/v1/admission/${pendingId}/${action}`,
            headers:{'content-length':0,...(name?{'x-loom-name':name}:{}),...(ticketId?{'x-loom-ticket':ticketId}:{})}},res=>{
            const peer=res.socket as TLSSocket,length=res.headers['content-length'];
            if(closed||!peer.authorized||peer.getPeerCertificate().fingerprint256!==daemonFingerprint
              ||res.statusCode!==(action==='admit'?200:204)||typeof length!=='string'||! /^(0|[1-9][0-9]{0,2})$/.test(length)
              ||Number(length)>256||(action!=='admit'&&length!=='0')||res.headers['transfer-encoding']){fail();res.destroy();return;}
            let body='';res.on('data',(bytes:Buffer)=>{body+=bytes.toString('utf8');if(Buffer.byteLength(body)>Number(length)){fail();res.destroy();}});
            res.on('error',fail);res.on('aborted',fail);
            res.on('end',()=>{if(settled)return;if(closed||Buffer.byteLength(body)!==Number(length)){fail();return;}settled=true;resolve(body);});
          });
          requests.add(req);const timer=setTimeout(()=>{fail();req.destroy();},5000);
          req.on('error',fail);req.once('close',()=>{clearTimeout(timer);requests.delete(req);});req.end();
        });
      }catch {throw failed();}
    }
    return Object.freeze({
      async admit(name:string) {
        if(attempted||closed||stopping)throw failed();attempted=true;
        try {secretName.parse(name);const value=replySchema.parse(JSON.parse(await call('admit',name)));
          if(value.pendingId!==pendingId)throw failed();ticketId=value.id;return ticketId;
        }catch {throw failed();}
      },
      async dispatch() {
        if(!ticketId||dispatched||closed||stopping)throw failed();dispatched=true;await call('dispatch');delivered=true;
      },
      close() {
        return closing??=(async()=>{
          stopping=true;
          await Promise.all([...requests].map(req=>new Promise<void>(resolve=>{req.once('close',resolve);req.destroy();})));
          if(ticketId&&!delivered)try {await call('cancel');}catch { /* lost ack stays consumed */ }
          closed=true;
        })();
      },
    });
  }catch {throw failed();}
}
