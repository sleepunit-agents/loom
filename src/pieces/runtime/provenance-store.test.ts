import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { provenanceStore } from './provenance-store.js';
import { principalFromHistory } from './provenance.js';
const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function setup() {
  const home=mkdtempSync(join(tmpdir(),'runtime-provenance-'));
  closes.push(()=>rmSync(home,{recursive:true,force:true}));fixture(home);
  const open=async()=>{const app=await startLoom({home,next:true,sharing:fixtureSharing});closes.push(app.close);return app;};
  return {home,open,app:await open()};
}
it('persists sender history and exact source keys through consumption and restart',async()=>{
  const f=await setup(), store=provenanceStore(f.app.db);
  const row={key:'source-1',sender:{kind:'person' as const,person:'jonathan'},at:1};
  expect(()=>store.note('cv-123456789abc','art',row,['jonathan'])).toThrow('transaction');
  f.app.db.transaction(()=>{store.note('cv-123456789abc','art',row,['jonathan']);store.consumed('cv-123456789abc',[row.key]);})();
  await f.app.close();const app=await f.open(), next=provenanceStore(app.db);
  expect(next.read('cv-123456789abc')?.queue).toEqual([]);
  expect(principalFromHistory(next.read('cv-123456789abc')!.history,['jonathan']).for).toBe('owner');
  app.db.transaction(()=>next.note('cv-123456789abc','art',row,['jonathan']))();
  expect(next.read('cv-123456789abc')?.queue).toEqual([]);
  expect(()=>app.db.transaction(()=>next.note('cv-123456789abc','art',{...row,sender:{kind:'unknown'}},['jonathan']))()).toThrow('another sender');
  expect(principalFromHistory(next.read('cv-123456789abc')!.history,[]).people).toEqual(['jonathan']);
});
it('rolls back history, queue and deduplication together on a late failure',async()=>{
  const {app}=await setup(),store=provenanceStore(app.db),row={key:'relay',sender:{kind:'agent' as const},at:1};
  expect(()=>app.db.transaction(()=>{store.note('cv-123456789abc','art',row,[]);throw Error('late');})()).toThrow('late');
  expect(store.read('cv-123456789abc')).toBeUndefined();
  app.db.transaction(()=>store.note('cv-123456789abc','art',row,[]))();
  expect(store.read('cv-123456789abc')?.queue).toEqual([row]);
  expect(()=>app.db.transaction(()=>store.note('cv-123456789abc','other',row,[]))()).toThrow('agent changed');
});
