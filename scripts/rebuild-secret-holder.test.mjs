/** Actual compiled startup and holder adapter; no browser, child or provider. */
import {it,expect,afterEach,vi} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import Database from 'better-sqlite3';
import {pathToFileURL} from 'node:url';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {assertSecretAudit} from './rebuild-secret-audit.mjs';
import {secretValueAction} from './rebuild-secret-value-actions.mjs';
import secretHolder,{holderValueEquals,holderValueAbsent} from './rebuild-secret-holder.mjs';
const fault=vi.hoisted(()=>({failStore:false,captureKeys:false,keys:[]}));
vi.mock('node:crypto',async original=>{
 const actual=await original();
 return {...actual,randomBytes(...args){const key=actual.randomBytes(...args);if(fault.captureKeys&&args[0]===32)fault.keys.push(key);return key;}};
});
vi.mock('../dist/pieces/secrets/holder-store.js',async original=>{
 const actual=await original();
 return {...actual,openHolderStore(...args){if(fault.failStore)return Promise.reject(Error('Fixture store opening failed'));return actual.openHolderStore(...args);}};
});
const clean=[];
afterEach(async()=>{fault.failStore=false;fault.captureKeys=false;fault.keys=[];for(const close of clean.splice(0).reverse())await close();});
function directory(){const path=mkdtempSync(join(tmpdir(),'loom-secret-adapter-test-'));clean.push(()=>rmSync(path,{recursive:true,force:true}));return path;}
async function prepared(){
 const home=join(directory(),'home');await exampleHome(home);
 const config=join(home,'program.json'),program=JSON.parse(readFileSync(config,'utf8')),adapter=join(home,'adapter.mjs');
 writeFileSync(adapter,"import create from "+JSON.stringify(new URL('./rebuild-secret-holder.mjs',import.meta.url).href)+";\nexport let captured; export default async context=>{captured=await create(context);return captured;};\n",{mode:0o600,flag:'wx'});
 program.adapters=adapter;writeFileSync(config,JSON.stringify(program));return home;
}
it('uses actual startup, owner signin and Root writes with exact encrypted-holder values and removal',async()=>{
 const home=await prepared();let link;
 const app=await startSharedHome({home,port:0,stdout:value=>{link=value.trim();},reportError:()=>{}});clean.push(()=>app.close());
 const headers={origin:app.url,'user-agent':'Fictional adapter proof'};
 const signin=await fetch(link,{method:'POST',redirect:'manual',headers});expect(signin.status).toBe(303);
 const cookie=signin.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 const send=async(operation,input)=>{
  const response=await fetch(app.url+'/api/secrets/'+operation,{method:'POST',headers:{...headers,cookie,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input})});
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true,value:{saved:true}});
 };
 const name='fixture-token';
 const firstId=randomUUID();
 await send('set',{id:firstId,name,mode:'add',description:'Fictional',value:'fictional-first'});
 const audit={home,name,member:'alex',writeIds:[firstId],actions:['add'],values:['fictional-first']};
 expect(()=>assertSecretAudit(audit)).not.toThrow();
 expect(()=>assertSecretAudit({...audit,member:'robin'})).toThrow('record');
 expect(()=>assertSecretAudit({...audit,writeIds:[randomUUID()]})).toThrow('record');
 expect(()=>assertSecretAudit({...audit,actions:['replace']})).toThrow('recorded exactly');
 // Actual owner-created metadata is the counterexample; no fake DB or row insert.
 expect(()=>assertSecretAudit({...audit,values:['Fictional']})).toThrow('value appeared');
 expect(await holderValueEquals(home,name,'fictional-first')).toBe(true);expect(await holderValueEquals(home,name,'wrong')).toBe(false);expect(holderValueAbsent(home,name)).toBe(false);
 await send('set',{id:randomUUID(),name,mode:'replace',value:'fictional-second'});
 expect(await holderValueEquals(home,name,'fictional-second')).toBe(true);expect(await holderValueEquals(home,name,'fictional-first')).toBe(false);
 await send('remove',{id:randomUUID(),name});expect(holderValueAbsent(home,name)).toBe(true);
 await app.close();expect(()=>holderValueAbsent(home,name)).toThrow('not active');
 await expect(holderValueEquals(home,name,'fictional-second')).rejects.toThrow('not active');
});
it('erases its retry-key snapshot and closes store access on adapter close',async()=>{
 const home=directory(),adapter=await secretHolder({home});clean.push(()=>adapter.close());
 const key=adapter.secretWrites.fingerprintKey;expect(key.some(value=>value!==0)).toBe(true);
 const who={member:'alex',writeId:randomUUID()};await adapter.secretWrites.holder.set(who,'example',Buffer.from('fictional'),'add');
 expect(await holderValueEquals(home,'example','fictional')).toBe(true);
 adapter.close();expect(key.every(value=>value===0)).toBe(true);expect(()=>holderValueAbsent(home,'example')).toThrow('not active');
 await expect(adapter.secretWrites.holder.set({member:'alex',writeId:randomUUID()},'other',Buffer.from('fictional'),'add')).rejects.toThrow();
});
it('closes an already opened fixture holder when actual listener startup fails',async()=>{
 const home=await prepared(),blocked=createServer();await new Promise(resolve=>blocked.listen(0,'127.0.0.1',resolve));
 clean.push(()=>new Promise(resolve=>blocked.close(resolve)));
 await expect(startSharedHome({home,port:blocked.address().port,stdout:()=>{},reportError:()=>{}})).rejects.toThrow();
 expect(()=>holderValueAbsent(home,'anything')).toThrow('not active');
 const {captured}=await import(pathToFileURL(join(home,'adapter.mjs')).href);
 expect(captured.secretWrites.fingerprintKey.every(value=>value===0)).toBe(true);
 await expect(captured.secretWrites.holder.set({member:'alex',writeId:randomUUID()},'example',Buffer.from('fictional'),'add')).rejects.toThrow();
});
it('erases both owned random-key buffers if the production store refuses to open',async()=>{
 const home=directory();fault.captureKeys=true;fault.failStore=true;
 await expect(secretHolder({home})).rejects.toThrow('Fixture store opening failed');
 expect(fault.keys).toHaveLength(2);expect(fault.keys.every(key=>key.every(value=>value===0))).toBe(true);
 expect(()=>holderValueAbsent(home,'anything')).toThrow('not active');
});
it('never calls a corrupt retained ciphertext an absent holder value',async()=>{
 const home=directory(),adapter=await secretHolder({home});clean.push(()=>adapter.close());
 await adapter.secretWrites.holder.set({member:'alex',writeId:randomUUID()},'example',Buffer.from('fictional'),'add');
 // Deliberate fault in this private test holder, not manufactured Root rows.
 const db=new Database(join(home,'walkthrough-holder/holder.db'));
 try{db.prepare('UPDATE holder_values SET ciphertext=? WHERE name=?').run(Buffer.from('corrupt'),'example');}finally{db.close();}
 await expect(holderValueEquals(home,'example','fictional')).rejects.toThrow();expect(holderValueAbsent(home,'example')).toBe(false);
});
it('reports a closed browser IO failure as false and redacts values without a fake successful frontend',async()=>{
 const screenshot=vi.fn(async()=>{throw Error('Browser closed');});
 // This boundary only throws: all successful program proof uses the real UI.
 const page={screenshot},tile={getByRole(){throw Error('Browser closed fictional-value-initial-6bd2');}};
 const result=await secretValueAction({page,tile,out:directory(),home:'unused'});
 expect(result).toMatchObject({ok:false,phase:'add',screenshot:'action-secret-value-failed.png'});
 expect(result.error).toContain('Browser closed');expect(result.error).not.toContain('fictional-value-initial-6bd2');expect(screenshot).toHaveBeenCalledOnce();
});
