import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,readSync,fstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {privateBytes} from './local-holder.js';
const real=await vi.importActual<typeof import('node:fs')>('node:fs');
vi.mock('node:fs',async()=>{
 const fs=await vi.importActual<typeof import('node:fs')>('node:fs');
 return {...fs,readSync:vi.fn(fs.readSync),fstatSync:vi.fn(fs.fstatSync)};
});
const homes:string[]=[];
afterEach(()=>{for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});vi.mocked(readSync).mockReset().mockImplementation(real.readSync);vi.mocked(fstatSync).mockReset().mockImplementation(real.fstatSync);});
function file(){const home=mkdtempSync(join(tmpdir(),'private-bytes-'));homes.push(home);const path=join(home,'key');writeFileSync(path,'ORIGINAL',{mode:0o600});return path;}
it('bounds bytes read and erases allocated material when a private file grows after inspection',()=>{
 const path=file(),captured:Buffer[]=[];let total=0;
 vi.mocked(fstatSync).mockImplementationOnce(fd=>{const before=real.fstatSync(fd);writeFileSync(path,Buffer.alloc(1_000_000,65));return before;});
 vi.mocked(readSync).mockImplementation((...args:Parameters<typeof real.readSync>)=>{
  const bytes=args[1] as Buffer;captured.push(bytes);expect(bytes.length).toBe(33);
  const n=real.readSync(...args);total+=n;return n;
 });
 expect(()=>privateBytes(path,32)).toThrow(/^Local secret holder unavailable$/);
 expect(total).toBe(33);expect(captured.length).toBeGreaterThan(0);expect(captured.every(b=>b.every(v=>v===0))).toBe(true);
});
it('returns an owned exact copy and erases scratch buffers on success and mid-read failure',()=>{
 const path=file(),captured:Buffer[]=[];
 vi.mocked(readSync).mockImplementation((...args:Parameters<typeof real.readSync>)=>{captured.push(args[1] as Buffer);return real.readSync(...args);});
 const value=privateBytes(path,32);expect(value.toString()).toBe('ORIGINAL');expect(captured.every(b=>b.every(v=>v===0))).toBe(true);value.fill(0);
 captured.length=0;
 vi.mocked(readSync).mockImplementationOnce((...args:Parameters<typeof real.readSync>)=>{captured.push(args[1] as Buffer);return real.readSync(...args);}).mockImplementationOnce(()=>{throw Error('PRIVATE');});
 expect(()=>privateBytes(path,32)).toThrow(/^Local secret holder unavailable$/);expect(captured.every(b=>b.every(v=>v===0))).toBe(true);
});

it('retains the explicit ciphertext bound and refuses invalid allocation limits',()=>{
 const path=file();writeFileSync(path,Buffer.alloc(128*1024,65));
 const value=privateBytes(path,128*1024);expect(value.length).toBe(128*1024);value.fill(0);
 for(const limit of [0,-1,NaN,Infinity,1.5,128*1024+1])expect(()=>privateBytes(path,limit)).toThrow(/^Local secret holder unavailable$/);
});

it.each(['mtimeMs','ctimeMs'] as const)('refuses same-size changed %s and erases scratch bytes',field=>{
 const path=file(),captured:Buffer[]=[];let stats=0;
 vi.mocked(fstatSync).mockImplementation(fd=>{const stat=real.fstatSync(fd);if(++stats===2)Object.assign(stat,{[field]:stat[field]+1000});return stat;});
 vi.mocked(readSync).mockImplementation((...args:Parameters<typeof real.readSync>)=>{captured.push(args[1] as Buffer);return real.readSync(...args);});
 expect(()=>privateBytes(path,32)).toThrow(/^Local secret holder unavailable$/);
 expect(stats).toBe(2);expect(captured.length).toBeGreaterThan(0);expect(captured.every(b=>b.every(v=>v===0))).toBe(true);
});
