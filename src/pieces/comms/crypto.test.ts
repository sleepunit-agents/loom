import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, chmodSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { loadKey, readKey } from './crypto.js';
const homes:string[]=[];afterEach(()=>{vi.restoreAllMocks();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
function home(){const h=mkdtempSync(join(tmpdir(),'comms-key-'));homes.push(h);return h;}
it('creates a private key and uses no child process for generation, encryption or decryption',async()=>{
 const spawn=vi.spyOn(childProcess,'spawn').mockImplementation(()=>{throw new Error('A process was started');});
 const sync=vi.spyOn(childProcess,'spawnSync').mockImplementation(()=>{throw new Error('A process was started');});
 const exec=vi.spyOn(childProcess,'execFile').mockImplementation(()=>{throw new Error('A process was started');});
 const h=home(),key=await loadKey(h),blob=await key.seal('private words');expect(await key.open(blob)).toBe('private words');
 expect(statSync(join(h,'comms.key')).mode&0o777).toBe(0o600);expect(spawn).not.toHaveBeenCalled();expect(sync).not.toHaveBeenCalled();expect(exec).not.toHaveBeenCalled();
});
it('refuses permissive keys and links, and fails closed on damaged ciphertext',async()=>{
 const h=home(),key=await loadKey(h);const path=join(h,'comms.key');chmodSync(path,0o644);expect(()=>readKey(path)).toThrow('private');chmodSync(path,0o600);
 const link=join(home(),'comms.key');symlinkSync(path,link);expect(()=>readKey(link)).toThrow();
 const blob=await key.seal('private words');blob[blob.length-1]^=1;await expect(key.open(blob)).rejects.toThrow();
});
