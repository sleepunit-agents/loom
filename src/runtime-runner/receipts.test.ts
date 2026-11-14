import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectWorkerReceipts, receiptPhases, reserveWorkerReceipt } from './receipts.js';

vi.mock('node:fs',async importOriginal=>{
  const actual=await importOriginal<typeof fs>();
  return {...actual,fsyncSync:vi.fn(actual.fsyncSync),writeSync:vi.fn(actual.writeSync)};
});
const cleanup:Array<()=>void>=[];
const actual=await vi.importActual<typeof fs>('node:fs');
afterEach(()=>{
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(actual.fsyncSync);
  vi.mocked(fs.writeSync).mockReset().mockImplementation(actual.writeSync);
  for(const close of cleanup.splice(0).reverse())close();
});
function setup() {
  const root=fs.mkdtempSync(join(tmpdir(),'worker-receipt-'));
  cleanup.push(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=join(root,'receipts');fs.mkdirSync(dir,{mode:0o700});
  return {root,dir,file:()=>join(dir,fs.readdirSync(dir)[0])};
}
it('durably reserves before returning and retains only ordered wordless evidence after reopening',()=>{
  const f=setup(),synced:string[]=[];
  const sync=vi.mocked(fs.fsyncSync),original=sync.getMockImplementation()!;
  sync.mockImplementation(fd=>{synced.push(fs.fstatSync(fd).isDirectory()?'directory':'file');original(fd);});
  const writer=reserveWorkerReceipt(f.dir,'j');
  expect(synced).toEqual(['file','directory']);
  for(const phase of receiptPhases.slice(1))writer.advance(phase);
  writer.close();
  expect(inspectWorkerReceipts(f.dir)).toEqual([{v:1,job:'j',attempt:expect.any(String),phase:'finished'}]);
  expect(synced).toHaveLength(receiptPhases.length+1);
  expect(fs.statSync(f.file()).mode&0o777).toBe(0o600);
  for(const line of fs.readFileSync(f.file(),'utf8').trim().split('\n'))
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(['attempt','job','phase','v']);
  expect(()=>reserveWorkerReceipt(f.dir,'j')).toThrow();
  expect(()=>writer.advance('finished')).toThrow();
});
it('a second writer cannot reserve a still-open job; an independent job can',()=>{
  const f=setup(),first=reserveWorkerReceipt(f.dir,'j');cleanup.push(first.close);
  expect(()=>reserveWorkerReceipt(f.dir,'j')).toThrow();
  const second=reserveWorkerReceipt(f.dir,'other');second.close();
  expect(inspectWorkerReceipts(f.dir).map(r=>r.job).sort()).toEqual(['j','other']);
});
it.each(['file','directory'] as const)('a failed initial %s sync leaves a blocking reservation',kind=>{
  const f=setup(),sync=vi.mocked(fs.fsyncSync),original=sync.getMockImplementation()!;
  sync.mockImplementation(fd=>{if(fs.fstatSync(fd).isDirectory()===(kind==='directory'))throw Error('disk');original(fd);});
  expect(()=>reserveWorkerReceipt(f.dir,'j')).toThrow();
  expect(fs.readdirSync(f.dir)).toHaveLength(1);
  expect(()=>reserveWorkerReceipt(f.dir,'j')).toThrow();
});
it('a partial append closes the writer and cannot be recovered as permission to retry',()=>{
  const f=setup(),writer=reserveWorkerReceipt(f.dir,'j'),write=vi.mocked(fs.writeSync),original=write.getMockImplementation()!;
  let writes=0;
  write.mockImplementation((...args:Parameters<typeof fs.writeSync>)=>{
    if(writes++===0)return original(args[0],Buffer.from('{'),0,1);
    throw Error('disk');
  });
  expect(()=>writer.advance('claim-attempt')).toThrow();
  expect(()=>writer.advance('claim-attempt')).toThrow();
  expect(()=>inspectWorkerReceipts(f.dir)).toThrow();
  expect(()=>reserveWorkerReceipt(f.dir,'j')).toThrow();writer.close();
});
it.each(['empty','partial','wrong-job','wrong-order','extra-field','oversized'] as const)('refuses %s evidence without deleting it',kind=>{
  const f=setup(),writer=reserveWorkerReceipt(f.dir,'j');writer.close();
  const original=fs.readFileSync(f.file(),'utf8'),value=JSON.parse(original);
  const text=kind==='empty'?'':kind==='partial'?original+'{':kind==='wrong-job'?JSON.stringify({...value,job:'other'})+'\n':
    kind==='wrong-order'?JSON.stringify({...value,phase:'finished'})+'\n':kind==='extra-field'?JSON.stringify({...value,token:'not a receipt field'})+'\n':'x'.repeat(16_385);
  fs.writeFileSync(f.file(),text);
  expect(()=>inspectWorkerReceipts(f.dir)).toThrow();expect(fs.readFileSync(f.file(),'utf8')).toBe(text);
  expect(()=>reserveWorkerReceipt(f.dir,'j')).toThrow();
});
it('refuses directory symlinks, dot components, permissive mode, receipt symlinks and hard links',()=>{
  const f=setup(),alias=join(f.root,'alias');fs.symlinkSync(f.dir,alias);
  for(const path of [alias,f.dir+'/',f.dir+'/../receipts',f.root+'/./receipts']) {
    expect(()=>reserveWorkerReceipt(path,'j')).toThrow();expect(()=>inspectWorkerReceipts(path)).toThrow();
  }
  fs.chmodSync(f.dir,0o755);expect(()=>reserveWorkerReceipt(f.dir,'j')).toThrow();fs.chmodSync(f.dir,0o700);
  const writer=reserveWorkerReceipt(f.dir,'j');writer.close();
  const file=f.file(),outside=join(f.root,'outside');fs.renameSync(file,outside);fs.symlinkSync(outside,file);
  expect(()=>inspectWorkerReceipts(f.dir)).toThrow();expect(()=>reserveWorkerReceipt(f.dir,'j')).toThrow();
  fs.unlinkSync(file);fs.linkSync(outside,file);expect(()=>inspectWorkerReceipts(f.dir)).toThrow();
});
