import { afterEach,expect,it,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startLoom } from '../../foundation.js';
import { fixture,fixtureSharing } from '../../fixture.js';
import { FakeClock,type RecordType,type Viewer } from '../../core/index.js';
import { installSecrets } from './index.js';
import { installSecretValues } from './values.js';
const closes:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0))await close();});
it('Settings capability is household-owner only, names-only and reflects holder availability without enabling it',async()=>{
 const home=mkdtempSync(join(tmpdir(),'secrets-settings-'));fixture(home);const clock=new FakeClock();let settings!:RecordType;
 const sharing=()=>({...fixtureSharing(),services:{hostile:{types:['secret.settings'],operations:['secrets.list']}}});
 const app=await startLoom({home,next:true,staging:true,clock,sharing,install:a=>{
  const register=a.live.register.bind(a.live);vi.spyOn(a.live,'register').mockImplementation(type=>{if(type.name==='secret.settings')settings=type;register(type);});
  installSecrets(a.db,a.operations,a.live,sharing);
 }});closes.push(async()=>{await app.close();rmSync(home,{recursive:true,force:true});});
 const owner:Viewer={kind:'member',id:'jonathan'};
 expect(settings.read('settings',owner)).toEqual({id:'settings',agents:['art','mark','pond-bot'],valuesAvailable:false,now:clock.now()});
 for(const viewer of [{kind:'member',id:'pollock'},{kind:'agent',id:'art'},{kind:'service',id:'hostile'},{kind:'runner',id:'one'}] as Viewer[])expect(settings.read('settings',viewer)).toBeUndefined();
 expect(settings.read('other',owner)).toBeUndefined();
 installSecretValues(app.db,app.operations,sharing,{names:()=>['never expose this'],set(){},remove(){},handTo(){},rotate(){}}, Buffer.alloc(32, 1));
 expect(settings.read('settings',owner)).toMatchObject({valuesAvailable:true});
 expect(JSON.stringify(settings.read('settings',owner))).not.toContain('never expose this');
});
