import {it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {acceptanceAdapter,prepareAcceptanceHome} from './rebuild-acceptance-adapter.mjs';

type Fixture={home:string;file:string;base(source:string):void};
async function fixture(run:(value:Fixture)=>Promise<void>){
 const home=mkdtempSync(join(tmpdir(),'loom-acceptance-adapter-')),file=join(home,'base.mjs');
 try{await run({home,file,base:source=>writeFileSync(file,source,{mode:0o600})});}finally{rmSync(home,{recursive:true,force:true});}
}
it('the consumer-generated module preserves a private catalog and initializes the real holder',()=>fixture(async({home,file,base})=>{
 base('export default context => context.previous;');
 const config=join(home,'program.json');writeFileSync(config,JSON.stringify({adapters:file,untouched:'retained'}),{mode:0o600});
 prepareAcceptanceHome(home);
 const program=JSON.parse(readFileSync(config,'utf8'));
 expect(program.untouched).toBe('retained');expect(statSync(program.adapters).mode&0o077).toBe(0);
 const modelRoles=()=>[{model:'fictional-model',provider:'fictional-provider'}],close=vi.fn();
 const module=await import(pathToFileURL(program.adapters).href);
 const result=await module.default({home,previous:{modelRoles,close}});
 try{expect(result.modelRoles).toBe(modelRoles);expect(result.secretWrites.holder.set).toBeTypeOf('function');}
 finally{await result.close();}
 expect(close).toHaveBeenCalledOnce();expect(result.secretWrites.fingerprintKey.every((byte:number)=>byte===0)).toBe(true);
}));
it('preserves catalog/context and holder ports, closing both once with their own receiver',()=>fixture(async({home,file,base})=>{
 base('export default context => context.previous;');
 const order=[],modelRoles=()=>[{model:'fictional-model',provider:'fictional-provider'}];
 const previous={modelRoles,async close(){expect(this).toBe(previous);order.push('base');}};
 const added={secretWrites:{holder:'fictional-holder'},async close(){expect(this).toBe(added);order.push('holder');}};
 const context={home,previous},additional=vi.fn(async(received:typeof context)=>{expect(received).toBe(context);return added;});
 const result=await acceptanceAdapter(file,additional)(context);
 expect(result.modelRoles).toBe(modelRoles);expect(result.modelRoles()).toEqual(modelRoles());
 expect(result.secretWrites).toBe(added.secretWrites);
 const first=result.close(),second=result.close();expect(first).toBe(second);await first;
 expect(order).toEqual(['holder','base']);expect(additional).toHaveBeenCalledOnce();
}));
it('preserves inherited accessors and non-enumerable startup ports with their original receiver',()=>fixture(async({file,base})=>{
 base('export default context => context.previous;');
 const order:string[]=[],roles=[{model:'class-model',provider:'class-provider'}],holder={fixture:true},bridge={fixture:true};
 class Previous{
  #roles=roles;
  get modelRoles(){return()=>this.#roles;}
  close(){order.push('base');}
 }
 class Added{
  #holder=holder;
  get secretWrites(){return this.#holder;}
  close(){order.push('holder');}
 }
 const previous=new Previous();Object.defineProperty(previous,'bridges',{value:bridge,enumerable:false});
 const result=await acceptanceAdapter(file,async()=>new Added())({previous});
 expect(result.modelRoles()).toBe(roles);expect(result.bridges).toBe(bridge);expect(result.secretWrites).toBe(holder);
 await result.close();expect(order).toEqual(['holder','base']);
}));
it('supports a fresh home without an existing adapter',async()=>{
 const close=vi.fn(),holder={secretWrites:{},close};
 const result=await acceptanceAdapter(undefined,async()=>holder)({});
 expect(result.secretWrites).toBe(holder.secretWrites);await result.close();expect(close).toHaveBeenCalledOnce();
});
it.each(['public','symlink','not-factory'])('rejects an unsafe or invalid existing module before holder setup: %s',kind=>fixture(async({file,base})=>{
 if(kind==='public')writeFileSync(file,'export default () => ({});',{mode:0o644});
 if(kind==='symlink'){const target=file+'.target';writeFileSync(target,'export default () => ({});',{mode:0o600});symlinkSync(target,file);}
 if(kind==='not-factory')base('export default {};');
 const additional=vi.fn(async()=>({}));
 await expect(acceptanceAdapter(file,additional)({})).rejects.toThrow();expect(additional).not.toHaveBeenCalled();
}));
it('closes acquired base ports if holder setup fails and preserves both failures',()=>fixture(async({file,base})=>{
 base('export default context => context.previous;');
 const setup=new Error('holder setup failed'),cleanup=new Error('base close failed');
 const close=vi.fn(async()=>{throw cleanup;});
 const failed=acceptanceAdapter(file,async()=>{throw setup;})({previous:{close}});
 await expect(failed).rejects.toMatchObject({errors:[setup,expect.objectContaining({errors:[cleanup]})]});
 expect(close).toHaveBeenCalledOnce();
}));
it('attempts both normal cleanups even when the holder close fails',()=>fixture(async({file,base})=>{
 base('export default context => context.previous;');
 const failure=new Error('holder close failed'),baseClose=vi.fn();
 const result=await acceptanceAdapter(file,async()=>({close:async()=>{throw failure;}}))({previous:{close:baseClose}});
 await expect(result.close()).rejects.toMatchObject({errors:[failure]});expect(baseClose).toHaveBeenCalledOnce();
}));
it('cleans both acquired factories when copying a port getter fails',()=>fixture(async({file,base})=>{
 base('export default context => context.previous;');
 const failure=new Error('bad port getter'),baseClose=vi.fn(),holderClose=vi.fn();
 const added={get secretWrites(){throw failure;},close:holderClose};
 await expect(acceptanceAdapter(file,async()=>added)({previous:{close:baseClose}})).rejects.toBe(failure);
 expect(baseClose).toHaveBeenCalledOnce();expect(holderClose).toHaveBeenCalledOnce();
}));
