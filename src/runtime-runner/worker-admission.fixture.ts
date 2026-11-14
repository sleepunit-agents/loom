import {expect,vi} from 'vitest';
import {join} from 'node:path';
import {ServerResponse} from 'node:http';
import {ticketAuthorityFixture} from './ticket-authority.fixture.js';
import {startAdmittedSecretCommand} from './admitted-secret-command.js';
import {listenWorkerAdmission} from '../pieces/secrets/worker-admission.js';
import {listenTicketAuthority} from '../pieces/secrets/ticket-authority.js';
import {localHolderHandoff,listenHolderHandoff} from '../pieces/secrets/holder-handoff.js';
import {routedHolderAuthority} from '../pieces/secrets/holder-routing.js';
import {workerSecretTransport} from './secret-transport.js';
export async function admissionFixture(closes:Array<()=>unknown>,releaseStaging=true) {
 const f=await ticketAuthorityFixture(closes);
 const binding={agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now()};
 await f.authority.close();
 const central=await listenTicketAuthority(f.server,f.fingerprint('holder'),f.tickets,[{fingerprint:f.fingerprint('daemon'),binding}]);closes.push(central.close);
 const holderSocket=join(f.home,'admitted-holder.sock');
 const client=localHolderHandoff({...f.server,socket:holderSocket,servername:'holder.test'},f.fingerprint('holder'));closes.push(client.close);
 const input=join(f.home,'admitted-input.sock');
 const transport=workerSecretTransport({...f.config,socket:input},f.fingerprint('daemon'));closes.push(transport.close);
 const source=vi.fn(async()=>Buffer.from('synthetic-admitted-value'));
 const holder=await listenHolderHandoff({...f.config,socket:holderSocket},{read:source},f.fingerprint('daemon'),routedHolderAuthority(f.remote,[{binding,transport}]));closes.push(holder.close);
 const socket=join(f.home,'admission.sock');
 const peer={fingerprint:f.fingerprint('daemon'),binding:{...binding},viewer:f.viewer,holder:client};
 const listener=await listenWorkerAdmission({...f.server,socket},f.tickets,[peer]);closes.push(listener.close);
 // Release only the synthetic staging effect, before admission reply reaches
 // the real worker. This is an owner action, not a transport retry or claim.
 if(releaseStaging) {
  const writeHead=ServerResponse.prototype.writeHead;
  vi.spyOn(ServerResponse.prototype,'writeHead').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['writeHead']>){
   if(this.req.url?.endsWith('/admit')&&args[0]===200) {
    const row=f.app.db.prepare('SELECT id FROM secrets_tickets').get() as {id:string};
    expect(f.tickets.claim(row.id)).toBeNull();f.release(row.id);
   }
   return Reflect.apply(writeHead,this,args);
  });
 }
 const marker=join(f.home,'consumer-metadata');
 const script="const fs=require('node:fs');let b=[];fs.createReadStream(null,{fd:3}).on('data',v=>b.push(v)).on('end',()=>{const ok=Buffer.concat(b).toString()==='synthetic-admitted-value';fs.writeFileSync(process.argv[1],ok?'accepted':'wrong');setTimeout(()=>process.exit(ok?0:1),200);});";
 const config={command:process.execPath,args:['-e',script,marker],cwd:f.home,env:{},
  input:{...f.server,socket:input},holderFingerprint:f.fingerprint('holder'),authority:{...f.config,cert:f.server.cert,key:f.server.key},
  daemonFingerprint:f.fingerprint('daemon'),admission:{...f.config,socket,cert:f.server.cert,key:f.server.key}};
 let current=true;
 const request={name:'API',binding,current:()=>current,expiresAt:Date.now()+20_000};
 const start=async()=>{const c=await startAdmittedSecretCommand(config,request);closes.push(c.close);return c;};
 const admitted=async()=>{
  await expect.poll(()=>f.app.db.prepare('SELECT id FROM secrets_tickets').get()).toBeTruthy();
  return (f.app.db.prepare('SELECT id FROM secrets_tickets').get() as {id:string}).id;
 };
 return {...f,binding,config,request,peer,listener,marker,source,start,admitted,revoke(){current=false;}};
}
