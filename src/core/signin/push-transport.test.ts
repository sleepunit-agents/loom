import { expect, it, vi } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { request as HttpsRequest } from 'node:https';
import type { IncomingMessage, ClientRequest } from 'node:http';
import webpush from 'web-push';
import { FakeClock } from '../clock.js';
import { sendPush } from './push-transport.js';
function fixture(){
 const ecdh=createECDH('prime256v1');ecdh.generateKeys();
 const sub={endpoint:'https://fcm.googleapis.com/proof',keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
 const options={vapidDetails:{subject:'mailto:loom@localhost',...webpush.generateVAPIDKeys()},TTL:600};
 const req=new EventEmitter() as ClientRequest;
 req.end=vi.fn(()=>req);req.destroy=vi.fn((error?:Error)=>{req.emit('error',error);req.emit('close');return req;});
 let response!:(res:IncomingMessage)=>void;
 const request=vi.fn((_url:unknown,_options:unknown,cb:typeof response)=>{response=cb;return req;}) as unknown as typeof HttpsRequest;
 const abort=new AbortController();
 const result=sendPush(sub,'PRIVATE PAYLOAD',options,abort.signal,request);
 const res=new EventEmitter() as IncomingMessage;res.resume=vi.fn(()=>res);
 return {req,res,request,result,abort,respond(code:number){res.statusCode=code;response(res);}};
}
it('owns an encrypted signed HTTPS request, drains responses and retains no external body',async()=>{
 const f=fixture();expect(f.request).toHaveBeenCalledWith('https://fcm.googleapis.com/proof',expect.objectContaining({method:'POST',headers:expect.objectContaining({Authorization:expect.any(String)})}),expect.any(Function));
 const body=vi.mocked(f.req.end).mock.calls[0][0];expect(Buffer.isBuffer(body)).toBe(true);expect(String(body)).not.toContain('PRIVATE PAYLOAD');
 f.respond(201);expect(f.res.resume).toHaveBeenCalledOnce();f.res.emit('data','PRIVATE SERVICE BODY');f.res.emit('end');await expect(f.result).resolves.toBeUndefined();f.req.emit('close');
});
it('aborts the owned request on the absolute deadline despite trickling response data',async()=>{
 const f=fixture(),clock=new FakeClock();const outcome=f.result.catch(e=>e);f.respond(201);
 clock.at(clock.now()+15_000,()=>f.abort.abort());
 for(let i=0;i<14;i++){clock.advance(1000);f.res.emit('data','still going');expect(f.req.destroy).not.toHaveBeenCalled();}
 clock.advance(1000);expect(f.req.destroy).toHaveBeenCalledOnce();expect(await outcome).toBeInstanceOf(Error);
});
it.each([404,410,503])('returns only status %s without body, endpoint or key diagnostics',async code=>{
 const f=fixture(),outcome=f.result.catch(e=>e);f.respond(code);f.res.emit('data','PRIVATE SERVICE BODY');f.res.emit('end');expect(await outcome).toEqual({statusCode:code});f.req.emit('close');
});
