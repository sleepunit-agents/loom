import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
const fakes = vi.hoisted(() => ({ lock:vi.fn(),create:vi.fn(),run:vi.fn(),check:vi.fn() }));
vi.mock('../transport/http-lock.js',()=>({acquireHttpLock:fakes.lock}));
vi.mock('../core/app.js',()=>({createFoundation:fakes.create}));
vi.mock('../pieces/attention/importer.js',()=>({importAttention:fakes.run,assertSeparateAttentionSources:fakes.check}));
import { migrateAttention } from './migrate-attention.js';
afterEach(()=>vi.resetAllMocks());
const io=()=>({stdout:vi.fn(),stderr:vi.fn(),stdin:Readable.from([]),stdinIsTTY:false,env:{}});
it('requires explicit destination, sources and audience map; rejects unknown options',async()=>{
  for(const argv of [[],['--from','old'],['--home','new','--from','old'],['--unknown']]) expect(await migrateAttention(argv,io())).toBe(2);
  expect(fakes.lock).not.toHaveBeenCalled(); expect(fakes.create).not.toHaveBeenCalled();
});
it('refuses a running home before opening source or destination',async()=>{
  fakes.lock.mockImplementation(()=>{throw Error('daemon running');});
  expect(await migrateAttention(['--home','new','--from','old','--scopes','map'],io())).toBe(1);
  expect(fakes.create).not.toHaveBeenCalled(); expect(fakes.run).not.toHaveBeenCalled();
});
it.each([false,true])('holds lock for entire batch and releases resources on failure=%s',async failure=>{
  const dir=mkdtempSync(join(tmpdir(),'attention-cli-')), map=join(dir,'map.json');
  try{
    writeFileSync(map,'{}'); const release=vi.fn(),close=vi.fn(); fakes.lock.mockReturnValue(release); fakes.create.mockReturnValue({db:{},close});
    fakes.run.mockImplementation((_db,paths,scopes)=>{expect(release).not.toHaveBeenCalled();expect(paths).toEqual(['a.db','b.db']);expect(scopes).toEqual({});if(failure)throw Error('interrupted');return {ok:true,imported:true};});
    const out=io(); expect(await migrateAttention(['--home','new','--from','a.db','--from','b.db','--scopes',map],out)).toBe(failure?1:0);
    expect(close).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledOnce();expect(fakes.lock).toHaveBeenCalledWith('new');
    if(!failure)expect(JSON.parse(out.stdout.mock.calls[0][0])).toEqual({ok:true,imported:true});
  }finally{rmSync(dir,{recursive:true,force:true});}
});

it('checks source identity before opening the destination for writes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'attention-cli-preflight-')),map=join(dir,'scopes.json');
  try { writeFileSync(map,'{}'); const release=vi.fn(); fakes.lock.mockReturnValue(release); fakes.check.mockImplementation(()=>{throw Error('source and destination must differ');});
    expect(await migrateAttention(['--home',dir,'--from',join(dir,'loom.db'),'--scopes',map],io())).toBe(1);
    expect(fakes.create).not.toHaveBeenCalled();expect(fakes.run).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
