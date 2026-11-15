import * as fs from 'node:fs';
import {Readable} from 'node:stream';
import {afterEach,expect,it,vi} from 'vitest';
import {run} from './migrate.js';
vi.mock('node:fs',async original=>{const actual=await original<typeof import('node:fs')>();return{...actual,readFileSync:vi.fn(actual.readFileSync),openSync:vi.fn(actual.openSync),existsSync:vi.fn(actual.existsSync)};});
afterEach(()=>vi.restoreAllMocks());
it.each([{argv:['runtime']},{argv:['runtime','--home','/fixture/destination','--from','/fixture/source','--mapping','/fixture/mapping.json']}])('rejects retired per-piece Runtime import without opening any supplied path: %j',async({argv})=>{
 vi.clearAllMocks();
 for(const fn of[fs.readFileSync,fs.openSync,fs.existsSync])vi.mocked(fn).mockImplementation(()=>{throw Error('Unexpected fixture file access');});
 const out:string[]=[],err:string[]=[];
 expect(await run(argv,{stdin:Readable.from([]),stdinIsTTY:false,stdout:value=>out.push(value),stderr:value=>err.push(value),env:{LOOM_HOME:'/fixture/home',LOOM_CONTEXT_DIR:'/fixture/context'}})).toBe(2);
 expect(out).toEqual([]);expect(err.join('')).toContain('Usage: loom migrate');
 for(const fn of[fs.readFileSync,fs.openSync,fs.existsSync])expect(fn).not.toHaveBeenCalled();
});
