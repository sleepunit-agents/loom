import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { migrateApprovals } from './migrate-approvals.js';
import { acquireHttpLock } from '../transport/http-lock.js';
import * as foundation from '../core/app.js';
import { load } from '../pieces/approvals/store.js';
const dirs:string[]=[];
const dir=()=>{const path=mkdtempSync(join(tmpdir(),'approvals-migration-'));dirs.push(path);return path;};
afterEach(()=>{for(const path of dirs.splice(0))rmSync(path,{recursive:true,force:true});});
it('refuses a running destination, releases locks on failure and success, and imports explicit project scope',async()=>{
  const databases: ReturnType<typeof foundation.createFoundation>['db'][]=[];
  const original=foundation.createFoundation;
  const spy=vi.spyOn(foundation,'createFoundation').mockImplementation(options=>{const app=original(options);databases.push(app.db);return app;});
  const home=dir(),source=dir(),map=join(dir(),'map.json');
  const receipt={id:'a-01234567',kind:'relay',target:'art->mark',what:'Ask Mark.',why:'He knows.',who:{agent:'art',where:'h-1'},for:'owner',minutes:60,at:'2026-11-12T00:00:00Z',state:'pending',conversation:'cv-0123456789ab'};
  writeFileSync(join(source,'approvals.json'),JSON.stringify({v:1,approvals:{[receipt.id]:receipt}}));
  writeFileSync(map,JSON.stringify({[receipt.conversation]:'pond',[receipt.id]:'guides'}));
  let stdout='',stderr='';
  const io={env:{},stdin:Readable.from([]),stdinIsTTY:false,stdout:(s:string)=>{stdout+=s;},stderr:(s:string)=>{stderr+=s;}};
  const argv=['--home',home,'--from',source,'--projects',map];
  const release=acquireHttpLock(home);
  try{expect(await migrateApprovals(argv,io)).toBe(1);expect(stderr).toContain('already running');}finally{release();}
  writeFileSync(map,'[]');expect(await migrateApprovals(argv,io)).toBe(1);
  const afterFailure=acquireHttpLock(home);afterFailure();
  writeFileSync(map,JSON.stringify({[receipt.conversation]:'pond',[receipt.id]:'guides'}));
  expect(await migrateApprovals(argv,io)).toBe(0);expect(stdout).toContain('"imported": true');
  const afterSuccess=acquireHttpLock(home);afterSuccess();
  expect(databases.every(db=>!db.open)).toBe(true);
  const app=original({home});try{expect(load(app.db).approvals).toEqual([{...receipt,project:'guides',agent:'art'}]);}finally{app.close();}
  expect(await migrateApprovals(argv,io)).toBe(0);
  writeFileSync(map,JSON.stringify({[receipt.id]:'pond'}));expect(await migrateApprovals(argv,io)).toBe(1);expect(stderr).toContain('different approvals source');
  expect(databases.every(db=>!db.open)).toBe(true);spy.mockRestore();
});
