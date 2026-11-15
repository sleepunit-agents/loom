/** Actual compiled child lifecycle. CI builds fresh first; local checks need build. */
import {it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
const run=promisify(execFile),moduleUrl=(name:string)=>JSON.stringify(pathToFileURL(resolve(import.meta.dirname,'../dist',name)).href);
const built=existsSync(resolve(import.meta.dirname,'../dist/shared-holder-process.js'));
if(process.env.CI==='true'&&!built)throw Error('Native holder proof requires a freshly built package');
it.runIf(built).each(['graceful','ready-timeout','post-ready-timeout'] as const)('joins the original native holder after %s without an IPC close-event hang',async mode=>{
 const home=mkdtempSync(join(tmpdir(),'loom-holder-native-'));
 const action={
  graceful:`const owner=await startSharedHolder(join(home,'secret-holder'),clock);await owner.close();if(!owner.fingerprintKey.every(byte=>byte===0))throw Error('Fingerprint key retained');`,
  'ready-timeout':`const fake=new FakeClock(Date.now()),pending=startSharedHolder(join(home,'secret-holder'),fake);fake.advance(5000);let refused=false;try{await pending;}catch{refused=true;}if(!refused)throw Error('Late holder admitted');`,
  'post-ready-timeout':`const fake=new FakeClock(Date.now()),owner=await startSharedHolder(join(home,'secret-holder'),fake),read=owner.source.read('TOKEN');fake.advance(5000);let refused=false;try{await read;}catch{refused=true;}if(!refused)throw Error('Timed-out read admitted');try{await owner.close();throw Error('Poisoned owner closed cleanly');}catch(error){if(!String(error).includes('unavailable'))throw error;}if(!owner.fingerprintKey.every(byte=>byte===0))throw Error('Fingerprint key retained');`,
 }[mode];
 const script=`import {join} from 'node:path';
 import {startSharedHolder} from ${moduleUrl('shared-holder-process.js')};import {initializeSharedHome} from ${moduleUrl('shared-initialize.js')};import {clock,FakeClock} from ${moduleUrl('core/clock.js')};
 const home=${JSON.stringify(home)};await initializeSharedHome(home,clock);${action}process.stdout.write('joined\\n');`;
 try{const result=await run(process.execPath,['--input-type=module','--eval',script],{cwd:'/',env:{},timeout:4000,maxBuffer:16_384});expect(result.stdout).toBe('joined\n');expect(result.stderr).toBe('');}
 finally{rmSync(home,{recursive:true,force:true});}
});
