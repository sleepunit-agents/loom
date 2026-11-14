import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startLoom} from '../../foundation.js';
import {FakeClock} from '../../core/index.js';
import {fixture as homeFixture,fixtureSharing} from '../../fixture.js';
import {installSecretServices,secretUseRole} from '../secrets/service.js';
import {afterEach, expect, it, vi} from 'vitest';
import {slackFiles,SLACK_FILE_BYTES,type SlackFilesPermit} from './slack-files.js';
import {venueSchema} from './model.js';
import type {SecretUse} from '../secrets/role.js';
const venue=venueSchema.parse({id:'v',agent:'art',platform:'slack',workspace:'TWORK',bot:'UBOT',tokenSecret:'slack-token'});
const attachment=(n=0)=>({id:`F0A${n}`,name:'../../photo 1.jpg',size:8,url:`https://files.slack.com/files-pri/TWORK-F0A${n}/photo.jpg`});
// Explicit fake Runtime delivered-message proof. No installed issuer exists.
function fixture(){
 let allowed=true,staging=true;
 const permit:SlackFilesPermit={agent:'art',venue:'v',workspace:'TWORK',channel:'DPLACE',delivery:'delivered:1',files:[attachment()],current:()=>allowed};
 const secrets:SecretUse={withValue:vi.fn(async(_name,use)=>use('fixture-token'))};
 const request=vi.fn<typeof fetch>(async()=>new Response('JPEGDATA',{headers:{'Content-Type':'image/jpeg'}}));
 return {permit,secrets,request,revoke:()=>{allowed=false;},hold:()=>{staging=false;},fetch:()=>slackFiles(venue,permit,secrets,()=>staging,request).fetch()};
}
afterEach(()=>vi.useRealTimers());
it('fetches first five files with per-request service use, original delivery scope and safe names',async()=>{
 const f=fixture();Object.assign(f.permit,{files:Array.from({length:6},(_,i)=>attachment(i))});
 const got=await f.fetch();expect(got).toHaveLength(5);expect(f.secrets.withValue).toHaveBeenCalledTimes(5);
 expect(got[0]).toEqual({id:'F0A0',name:'photo_1.jpg',bytes:Buffer.from('JPEGDATA')});
 expect(f.request).toHaveBeenNthCalledWith(1,attachment().url,expect.objectContaining({method:'GET',redirect:'error',headers:{Authorization:'Bearer fixture-token'},signal:expect.any(AbortSignal)}));
});
it.each(['https://evil.example/x','http://files.slack.com/x','https://files.slack.com.evil/x','https://u:p@files.slack.com/x','https://files.slack.com:443/x','https://evil.example\\@files.slack.com/x','https://files.slack.com/x#fragment','https://files.slack.com/\nx'])('refuses untrusted URL before secret use: %s',async url=>{
 const f=fixture();Object.assign(f.permit.files[0],{url});await expect(f.fetch()).rejects.toThrow('Bridge file fetch held');expect(f.secrets.withValue).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();
});
it.each([{id:'../file'},{size:SLACK_FILE_BYTES+1},{size:-1},{size:1.5},{name:'x'.repeat(4097)}])('preflights malformed descriptors %j',async change=>{
 const f=fixture();Object.assign(f.permit.files[0],change);await expect(f.fetch()).rejects.toThrow();expect(f.request).not.toHaveBeenCalled();
});
it.each([{agent:'other'},{venue:'other'},{workspace:'TOTHER'},{channel:'../place'},{delivery:''}])('refuses wrong exact scope %j',async change=>{
 const f=fixture();Object.assign(f.permit,change);await expect(f.fetch()).rejects.toThrow();expect(f.request).not.toHaveBeenCalled();
});
it('refuses held/revoked proofs before secret use',async()=>{
 for(const gate of ['revoke','hold'] as const){const f=fixture();f[gate]();await expect(f.fetch()).rejects.toThrow();expect(f.secrets.withValue).not.toHaveBeenCalled();}
});
it('rechecks after asynchronous holder acquisition',async()=>{
 const f=fixture();f.secrets.withValue=async(_name,use)=>{f.revoke();return use('private-token');};await expect(f.fetch()).rejects.toThrow();expect(f.request).not.toHaveBeenCalled();
});
it.each(['revoke','hold','scope','files'])('rechecks after headers: %s',async change=>{
 const f=fixture();let cancelled=false;
 f.request.mockImplementation(async()=>{if(change==='revoke')f.revoke();if(change==='hold')f.hold();if(change==='scope')Object.assign(f.permit,{delivery:'another'});if(change==='files')Object.assign(f.permit.files[0],{id:'FOTHER'});
 return new Response(new ReadableStream({cancel(){cancelled=true;}}));});
 await expect(f.fetch()).rejects.toThrow('Bridge file fetch held');expect(cancelled).toBe(true);
});
it.each([{status:302},{status:404},{headers:{'content-type':'TEXT/HTML; charset=utf-8'}},{headers:{'content-type':'application/xhtml+xml'}},{headers:{'content-length':String(SLACK_FILE_BYTES+1)}},{headers:{'content-length':'bogus'}}])('refuses non-files %j',async init=>{
 const f=fixture();f.request.mockResolvedValue(new Response('private upstream words',init));await expect(f.fetch()).rejects.toThrow('Bridge file fetch held');
});
it('bounds actual bytes independently of metadata and cancels oversized streams',async()=>{
 const f=fixture();let cancelled=false;f.request.mockResolvedValue(new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(SLACK_FILE_BYTES));c.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}})));
 await expect(f.fetch()).rejects.toThrow('Bridge file fetch held');expect(cancelled).toBe(true);
});
it('rechecks proof during body streaming and cancels',async()=>{
 const f=fixture();let cancelled=false;
 f.request.mockResolvedValue(new Response(new ReadableStream({pull(c){f.revoke();c.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}})));
 await expect(f.fetch()).rejects.toThrow();expect(cancelled).toBe(true);
});
it.each(['headers','body'])('bounds stalled %s at fifteen seconds, with a fake clock',async where=>{
 vi.useFakeTimers();const f=fixture();let cancelled=false;
 f.request.mockImplementation(where==='headers'?()=>new Promise(()=>{}):async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})));
 const result=f.fetch();const check=expect(result).rejects.toThrow('Bridge file fetch held');
 await vi.advanceTimersByTimeAsync(14999);let done=false;void result.catch(()=>{done=true;});await Promise.resolve();expect(done).toBe(false);
 await vi.advanceTimersByTimeAsync(1);await check;if(where==='body')expect(cancelled).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it('sanitizes HTTP and holder errors',async()=>{
 const f=fixture();f.request.mockRejectedValue(Error('private-token https://private-path'));await expect(f.fetch()).rejects.toThrow(/^Bridge file fetch held$/);
 f.secrets.withValue=async()=>{throw Error('secret private-token');};await expect(f.fetch()).rejects.toThrow(/^Bridge file fetch held$/);
});

it('uses actual Secrets service grants and erases holder buffers in a synthetic next home',async()=>{
 const home=mkdtempSync(join(tmpdir(),'slack-files-'));homeFixture(home);
 const sharing=()=>({...fixtureSharing(),services:{bridges:{types:['bridges.venue'],operations:[]}}});
 const clock=new FakeClock(100_000),app=await startLoom({home,next:true,clock,sharing,stdout:()=>{}});
 try{
  installSecretServices(app.db,app.operations,sharing);
  const f=fixture(),buffers:Uint8Array[]=[],owner={kind:'member' as const,id:'jonathan'};
  const source={read:vi.fn(async()=>{const bytes=Buffer.from('FIXTURE-CREDENTIAL');buffers.push(bytes);return bytes;})};
  const transport=slackFiles(venue,f.permit,secretUseRole(app.db,source,sharing,{kind:'service',id:'bridges'},()=>clock.now(),app.live),()=>true,f.request);
  await expect(transport.fetch()).rejects.toThrow();expect(source.read).not.toHaveBeenCalled();
  expect(app.operations.call('direct',owner,'secrets.describe',{name:'slack-token',description:'Fixture'},'describe').ok).toBe(true);
  expect(app.operations.call('direct',owner,'secrets.grantService',{service:'bridges',name:'slack-token'},'grant').ok).toBe(true);
  expect((await transport.fetch())[0].bytes.toString()).toBe('JPEGDATA');
  expect(f.request.mock.calls[0][1]?.headers).toEqual({Authorization:'Bearer FIXTURE-CREDENTIAL'});
  expect(buffers).toHaveLength(1);expect(buffers[0].every(v=>v===0)).toBe(true);
  expect(app.operations.call('direct',owner,'secrets.revokeService',{service:'bridges',name:'slack-token'},'revoke').ok).toBe(true);
  await expect(transport.fetch()).rejects.toThrow();expect(f.request).toHaveBeenCalledTimes(1);
 }finally{await app.close();rmSync(home,{recursive:true,force:true});}
});

it.each(['second request','proof throws','holder rejects'])('erases owned buffers on failed batch: %s',async phase=>{
 const f=fixture(),owned:Buffer[]=[];
 Object.assign(f.permit,{files:[attachment(),attachment(1)]});
 let calls=0;
 f.secrets.withValue=async(_name,use)=>{
  if(++calls===2)throw Error('holder unavailable');
  const bytes=await use('fixture-token');owned.push(bytes as Buffer);
  if(phase==='proof throws')Object.assign(f.permit,{current(){throw Error('Runtime unavailable');}});
  if(phase==='holder rejects')throw Error('holder failed after callback');
  return bytes;
 };
 await expect(f.fetch()).rejects.toThrow(/^Bridge file fetch held$/);
 expect(owned).toHaveLength(1);expect(owned[0].every(byte=>byte===0)).toBe(true);
});

it.each(['agent','venue','workspace','channel','delivery','files'])('binds %s at transport creation, before any request',async key=>{
 const f=fixture(),transport=slackFiles(venue,f.permit,f.secrets,()=>true,f.request);
 Object.assign(f.permit,{[key]:key==='files'?[attachment(1)]:key==='channel'?'DOTHER':'other'});
 await expect(transport.fetch()).rejects.toThrow();expect(f.secrets.withValue).not.toHaveBeenCalled();
});
