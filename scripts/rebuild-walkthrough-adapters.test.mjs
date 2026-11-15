/** Real encrypted holder and filesystem boundaries; all values are fictitious. */
import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,chmodSync,renameSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {installWalkthroughAdapters} from './rebuild-walkthrough-adapters.mjs';
import {holderValueEquals,holderValueAbsent} from './rebuild-secret-holder.mjs';
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'loom-composed-fixture-')),base=join(home,'base.mjs'),config=join(home,'program.json');
 writeFileSync(base,`import {writeFileSync} from 'node:fs';import {join} from 'node:path';
 writeFileSync(new URL('./base-loaded',import.meta.url),'loaded');
 export default ({home})=>({modelRoles:()=>[{model:'fictitious-model',provider:'fictitious-provider',harness:'fictitious-harness',series:'fictitious'}],approvedOperations:new Map([['fixture.operation',()=>{}]]),close(){writeFileSync(join(home,'base-closed'),'closed');}});`,{mode:0o600});
 writeFileSync(config,JSON.stringify({adapters:base}),{mode:0o600});
 const open=async()=>{installWalkthroughAdapters(home);const module=await import(pathToFileURL(JSON.parse(readFileSync(config,'utf8')).adapters).href);return module.default({home});};
 return {home,base,config,open};
}
it('keeps model roles, prepared operations and real encrypted writes, then closes both adapters',async()=>{
 const f=fixture();let adapters,closed=false;const value='FICTITIOUS_COMPOSED_VALUE',bytes=Buffer.from(value);
 try{
  adapters=await f.open();expect(adapters.modelRoles()).toEqual([{model:'fictitious-model',provider:'fictitious-provider',harness:'fictitious-harness',series:'fictitious'}]);expect(adapters.approvedOperations.has('fixture.operation')).toBe(true);
  await adapters.secretWrites.holder.set({member:'alex',writeId:randomUUID()},'COMPOSED',bytes,'add');
  expect(await holderValueEquals(f.home,'COMPOSED',value)).toBe(true);expect(existsSync(join(f.home,'base-closed'))).toBe(false);
  closed=true;await adapters.close();expect(existsSync(join(f.home,'base-closed'))).toBe(true);expect(()=>holderValueAbsent(f.home,'COMPOSED')).toThrow('not active');
 }finally{bytes.fill(0);if(!closed)await adapters?.close();rmSync(f.home,{recursive:true,force:true});}
});
it('closes the base when holder construction fails',async()=>{
 const f=fixture();writeFileSync(join(f.home,'walkthrough-holder'),'FICTITIOUS_PATH_BLOCKER',{mode:0o600});
 try{await expect(f.open()).rejects.toThrow();expect(existsSync(join(f.home,'base-loaded'))).toBe(true);expect(existsSync(join(f.home,'base-closed'))).toBe(true);expect(()=>holderValueAbsent(f.home,'COMPOSED')).toThrow('not active');}
 finally{rmSync(f.home,{recursive:true,force:true});}
});
it.each([['config','mode'],['base','mode'],['config','symlink'],['base','symlink']])('rejects unsafe %s %s before loading the base',async(field,kind)=>{
 const f=fixture(),file=f[field];
 try{
  if(kind==='mode')chmodSync(file,0o644);else{renameSync(file,file+'.private');symlinkSync(file+'.private',file);}
  expect(()=>installWalkthroughAdapters(f.home)).toThrow();expect(existsSync(join(f.home,'base-loaded'))).toBe(false);expect(existsSync(join(f.home,'walkthrough-adapter.mjs'))).toBe(false);
 }finally{rmSync(f.home,{recursive:true,force:true});}
});
