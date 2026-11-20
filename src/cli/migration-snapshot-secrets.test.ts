import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,readdirSync,lstatSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {migrateSnapshot} from './migration-snapshot.js';

vi.mock('node:fs',async original=>{
  const fs=await original<typeof import('node:fs')>();
  return {...fs,realpathSync:vi.fn(fs.realpathSync),readdirSync:vi.fn(fs.readdirSync),lstatSync:vi.fn(fs.lstatSync),readFileSync:vi.fn(fs.readFileSync)};
});
const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
it('omitted Secrets option never probes environment/default roots on dry-run or copy',async()=>{
  const root=mkdtempSync(join(tmpdir(),'snapshot-no-implicit-secrets-'));roots.push(root);
  const home=join(root,'old-home'),fakeHome=join(root,'user'),external=join(root,'env-secrets');
  const defaultSecrets=join(fakeHome,'.config/loom-secrets');
  for(const p of [home,defaultSecrets,external])mkdirSync(p,{recursive:true});
  writeFileSync(join(home,'household.json'),JSON.stringify({v:1,agents:['art'],default:'art',owner:'jonathan'}));
  for(const p of [defaultSecrets,external])writeFileSync(join(p,'store.sops.json'),'{"API":"ENC[AES256_GCM,data:FIXTURE_ONLY,type:str]"}');
  vi.stubEnv('HOME',fakeHome);vi.stubEnv('LOOM_SECRETS_DIR',external);
  for(const dry of [true,false]) {
    vi.clearAllMocks();
    const output:string[]=[],to=join(root,dry?'dry':'snapshot');
    const io={stdout:(s:string)=>output.push(s),stderr:(s:string)=>output.push(s),stdin:Readable.from([]),stdinIsTTY:false,env:{HOME:fakeHome,LOOM_SECRETS_DIR:external}};
    expect(await migrateSnapshot(['--from',home,'--to',to,...(dry?['--dry-run']:[])],io)).toBe(0);
    for(const fn of [realpathSync,readdirSync,lstatSync,readFileSync]) {
      const paths=vi.mocked(fn).mock.calls.map(args=>String(args[0]));
      expect(paths.some(p=>p===external||p.startsWith(external+'/')||p===defaultSecrets||p.startsWith(defaultSecrets+'/'))).toBe(false);
    }
    expect(output.join('')).not.toContain('FIXTURE_ONLY');
    if(dry)expect(JSON.parse(output.join('')).copies.every((f:{path:string})=>!f.path.startsWith('secrets/'))).toBe(true);
    else expect(JSON.parse(readFileSync(join(to,'manifest.json'),'utf8')).files.every((f:{path:string})=>!f.path.startsWith('secrets/'))).toBe(true);
  }
});
