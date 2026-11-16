import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({mode:'normal',rootCloses:0,clientCloses:0,clients:[],dispose:[],secret:'loom_'+'x'.repeat(43)+' '+ 'a'.repeat(64)}));
vi.mock('../dist/shared-root.js',async original=>{
 const actual=await original();
 return {...actual,sharedRoot:options=>{
  const root=actual.sharedRoot(options),mode=f.mode,closeRoot=root.close.bind(root),client=options.db.$client,closeClient=client.close.bind(client),request=root.http.request.bind(root.http);
  let injected=false;f.clients.push(client);f.dispose.push(closeRoot);
  client.close=()=>{f.clientCloses++;const result=closeClient();if(mode==='client-close')throw Error(f.secret);return result;};
  root.http.request=(...args)=>{if(!injected&&mode==='exception'){injected=true;throw Error(f.secret);}if(!injected&&mode==='check'){injected=true;return Promise.resolve(Response.json({}));}return request(...args);};
  return {...root,close:async()=>{f.rootCloses++;await closeRoot();if(mode==='root-close')throw Error(f.secret);}};
 }};
});
import {signinDoorEvidence} from './rebuild-signin-door.mjs';
beforeEach(()=>{f.mode='normal';f.rootCloses=0;f.clientCloses=0;f.clients=[];f.dispose=[];});
afterEach(async()=>{for(const dispose of f.dispose)await dispose();for(const client of f.clients)if(client.open)client.close();});
it('proves the actual isolated sign-in door and returns only completed boolean evidence',async()=>{
 const result=await signinDoorEvidence();expect(result.ok,result.error).toBe(true);
 expect(result).toMatchObject({ok:true,checks:{trustedServiceWithoutToken:true,unauthenticatedDenied:true,memberAgentMachineAuthenticated:true,memberIdentityBound:true,nonownerIssuanceDenied:true,oneUseLink:true,expiredLinkDenied:true,sixHourAutomatedSession:true,personSessionRetained:true,personalMetadataOnly:true,ownerHouseholdList:true,ownerSessionRevocation:true,ownerTokenRevocation:true,tokenCookieLinkFingerprints:true,rawSecretsNeverPersisted:true,closed:true}});
 expect(Object.values(result.checks).every(value=>value===true)).toBe(true);expect(f.rootCloses).toBe(1);expect(f.clientCloses).toBe(1);expect(f.clients.every(client=>!client.open)).toBe(true);
});
it.each(['check','exception','root-close','client-close'])('fails closed with no raw diagnostics and completes all cleanup after %s failure',async mode=>{
 f.mode=mode;const result=await signinDoorEvidence();expect(result.ok).toBe(false);expect(result.checks).toBeUndefined();
 expect(result.error).toMatch(/^Sign-in door evidence (failed: [a-z -]+|cleanup failed)$/);
 expect(JSON.stringify(result)).not.toContain(f.secret);expect(JSON.stringify(result)).not.toMatch(/loom_|[a-f0-9]{64}/);expect(f.rootCloses).toBe(1);expect(f.clientCloses).toBe(1);expect(f.clients.every(client=>!client.open)).toBe(true);
});
it('keeps two simultaneously active fictional homes and their credentials isolated',async()=>{
 const results=await Promise.all([signinDoorEvidence(),signinDoorEvidence()]);expect(results.map(result=>result.ok)).toEqual([true,true]);expect(f.rootCloses).toBe(2);expect(f.clientCloses).toBe(2);expect(f.clients.every(client=>!client.open)).toBe(true);
});
