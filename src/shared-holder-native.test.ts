/** Actual compiled child lifecycle: fake EventEmitters miss IPC EOF/close ordering. */
import {it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
const run=promisify(execFile),moduleUrl=(name:string)=>JSON.stringify(pathToFileURL(resolve(import.meta.dirname,'../dist',name)).href);
it.each(['graceful','ready-timeout','post-ready-timeout'] as const)('joins the original native holder after %s without an IPC close-event hang',async mode=>{
 const home=mkdtempSync(join(tmpdir(),'loom-holder-native-'));
 const script=`
 import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
 import {startSharedHolder} from ${moduleUrl('shared-holder-process.js')};import {initializeSharedHome} from ${moduleUrl('shared-initialize.js')};import {clock,FakeClock} from ${moduleUrl('core/clock.js')};
 const home=${JSON.stringify(home)};
 try{await initializeSharedHome(home,clock);
 if(${JSON.stringify(mode)}==='graceful'){const owner=await startSharedHolder(join(home,'secret-holder'),clock);await owner.close();if(!owner.fingerprintKey.every(byte=>byte===0))throw Error('Fingerprint key retained');}
 else if(${JSON.stringify(mode)}==='post-ready-timeout'){const fake=new FakeClock(Date.now()),owner=await startSharedHolder(join(home,'secret-holder'),fake),read=owner.source.read('TOKEN');fake.advance(5000);let refused=false;try{await read;}catch{refused=true;}if(!refused)throw Error('Timed-out read admitted');try{await owner.close();throw Error('Poisoned owner closed cleanly');}catch(error){if(!String(error).includes('unavailable'))throw error;}if(!owner.fingerprintKey.every(byte=>byte===0))throw Error('Fingerprint key retained');}
 else{const fake=new FakeClock(Date.now()),pending=startSharedHolder(join(home,'secret-holder'),fake);fake.advance(5000);let refused=false;try{await pending;}catch{refused=true;}if(!refused)throw Error('Late holder admitted');}
 process.stdout.write('joined\\n');
 }finally{rmSync(home,{recursive:true,force:true});}`;
 try{const result=await run(process.execPath,['--input-type=module','--eval',script],{cwd:'/',env:{},timeout:4000,maxBuffer:16_384});expect(result.stdout).toBe('joined\n');expect(result.stderr).toBe('');}finally{rmSync(home,{recursive:true,force:true});}
});
