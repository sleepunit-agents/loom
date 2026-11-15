import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { repositoryInstructions, MAX_LANE_FILE_BYTES } from './repository.js';
const roots:string[]=[];
const temp=()=>{const root=fs.mkdtempSync(join(tmpdir(),'tempo-repository-'));roots.push(root);return root;};
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
it('reads exact current words from only the configured repository',()=>{
 const root=temp();fs.mkdirSync(join(root,'routines'));fs.writeFileSync(join(root,'routines/check.md'),'Check the pump.\n');
 const read=repositoryInstructions(root);expect(read('routines/check.md')).toBe('Check the pump.\n');
 fs.writeFileSync(join(root,'routines/check.md'),'Updated words');expect(read('routines/check.md')).toBe('Updated words');
});
it('rejects traversal, ambiguous references and every symlink component',()=>{
 const root=temp(),outside=temp();fs.writeFileSync(join(root,'lane'),'inside');fs.writeFileSync(join(outside,'lane'),'PRIVATE OUTSIDE');
 fs.symlinkSync(join(outside,'lane'),join(root,'file'));fs.symlinkSync(outside,join(root,'directory'));fs.symlinkSync(root,join(outside,'repo'));
 fs.symlinkSync(join(root,'lane'),join(root,'internal'));
 fs.mkdirSync(join(root,'checkout'));fs.writeFileSync(join(root,'checkout/lane'),'inside');
 expect(()=>repositoryInstructions(join(outside,'repo/checkout'))('lane')).toThrow('unavailable or unsafe');
 const read=repositoryInstructions(root);
 for(const file of ['../lane','/lane','a/../lane','./lane','a//lane','a\\lane','lane/','file','directory/lane','internal'])expect(()=>read(file)).toThrow();
 for(const repo of [root+'/',root+'/.',root+'/../'+root.split('/').at(-1),join(outside,'repo'),'/'])expect(()=>repositoryInstructions(repo)('lane')).toThrow();
});
it('requires a bounded regular UTF-8 file and keeps unsafe errors word-free',()=>{
 const root=temp(),read=repositoryInstructions(root);fs.mkdirSync(join(root,'directory'));
 for(const [name,words] of [['empty',''],['blank',' \n'],['nul','words\0'],['large','x'.repeat(MAX_LANE_FILE_BYTES+1)]] as const)fs.writeFileSync(join(root,name),words);
 fs.writeFileSync(join(root,'invalid'),Buffer.from([255]));
 for(const file of ['directory','missing','empty','blank','nul','large','invalid'])expect(()=>read(file)).toThrow('unavailable or unsafe');
 fs.writeFileSync(join(root,'limit'),'x'.repeat(MAX_LANE_FILE_BYTES));expect(read('limit')).toHaveLength(MAX_LANE_FILE_BYTES);
});
it('detects an in-place file change before returning words',()=>{
 const root=temp();fs.writeFileSync(join(root,'lane'),'first');const read=fs.readSync;let changed=false;
 vi.spyOn(fs,'readSync').mockImplementation((...args:Parameters<typeof fs.readSync>)=>{
  const count=Reflect.apply(read,fs,args);if(!changed){changed=true;fs.writeFileSync(join(root,'lane'),'changed words');}return count;
 });
 expect(()=>repositoryInstructions(root)('lane')).toThrow('unavailable or unsafe');
});
it('pins a directory when its pathname is replaced by an outside link mid-read',()=>{
 const root=temp(),outside=temp();fs.mkdirSync(join(root,'routines'));fs.writeFileSync(join(root,'routines/lane'),'safe words');fs.writeFileSync(join(outside,'lane'),'PRIVATE OUTSIDE');
 const open=fs.openSync;let replaced=false;
 vi.spyOn(fs,'openSync').mockImplementation((...args:Parameters<typeof fs.openSync>)=>{
  const fd=Reflect.apply(open,fs,args);
  if(String(args[0]).endsWith('/routines')&&!replaced){replaced=true;fs.renameSync(join(root,'routines'),join(root,'original'));fs.symlinkSync(outside,join(root,'routines'));}
  return fd;
 });
 expect(repositoryInstructions(root)('routines/lane')).toBe('safe words');expect(replaced).toBe(true);
 expect(()=>repositoryInstructions(root)('routines/lane')).toThrow('unavailable or unsafe');
});
it('closes every opened descriptor after successful and failed reads',()=>{
 const root=temp();fs.mkdirSync(join(root,'directory'));fs.writeFileSync(join(root,'lane'),'words');
 const opened:number[]=[],closed:number[]=[],open=fs.openSync,close=fs.closeSync;
 vi.spyOn(fs,'openSync').mockImplementation((...args:Parameters<typeof fs.openSync>)=>{const fd=Reflect.apply(open,fs,args);opened.push(fd);return fd;});
 vi.spyOn(fs,'closeSync').mockImplementation(fd=>{closed.push(fd);return close(fd);});
 expect(repositoryInstructions(root)('lane')).toBe('words');
 expect(()=>repositoryInstructions(root)('directory/missing')).toThrow();
 expect(closed.slice().sort()).toEqual(opened.slice().sort());
});

it('fails on unsupported hosts before opening any filesystem path',()=>{
 const root=temp();fs.writeFileSync(join(root,'lane'),'words');const opened=vi.spyOn(fs,'openSync');
 vi.stubGlobal('process',Object.create(process,{platform:{value:'darwin'}}));
 try{expect(()=>repositoryInstructions(root)('lane')).toThrow('configured repository');expect(opened).not.toHaveBeenCalled();}
 finally{vi.unstubAllGlobals();}
});
