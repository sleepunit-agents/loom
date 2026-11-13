import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { FakeClock } from '../../core/index.js';
import { signin, hash } from '../../core/signin/index.js';
import { setupLocal, caller, value } from '../../__fixtures__/clock-local.js';
import { clockLocalStanding } from '../clock/role.js';
import { wakes } from '../clock/store.js';
import { load } from './store.js';

it('answers household standing filings over HTTP and schedules once with atomic rollback across restart', async () => {
  const s = await setupLocal('standing');
  const card = value<{id:string}>(s.request()).id;
  const receipt = randomUUID(), input = {id:card};
  const answer = async () => (await fetch(`${s.app.url}/api/approvals/every-time`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({id:receipt,input}),
  })).json();
  s.app.db.exec("CREATE TRIGGER fail_standing_http BEFORE INSERT ON approvals_rules BEGIN SELECT RAISE(ABORT,'fixture'); END");
  const before = load(s.app.db);
  expect(await answer()).toMatchObject({ok:false});
  expect(load(s.app.db)).toEqual(before);
  s.app.db.exec('DROP TRIGGER fail_standing_http');
  const allowed = await answer(); expect(allowed).toMatchObject({ok:true});
  await s.restart(); expect(await answer()).toEqual(allowed);
  const schedule = {approval:card,mode:'in' as const,when:'1h'}, use = randomUUID();
  const recover = () => clockLocalStanding(s.app.operations).schedule(caller,schedule,use);
  const approved = load(s.app.db);
  s.app.db.exec("CREATE TRIGGER fail_wake_http BEFORE INSERT ON clock_wakes BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(recover()).toMatchObject({ok:false}); expect(load(s.app.db)).toEqual(approved);
  expect(wakes(s.app.db)).toEqual([]);
  s.app.db.exec('DROP TRIGGER fail_wake_http');
  const scheduled = recover(); expect(scheduled).toMatchObject({ok:true});
  await s.restart(); expect(recover()).toEqual(scheduled);
  expect(wakes(s.app.db)).toHaveLength(1);
  expect(load(s.app.db).audit.filter(a=>a.event==='standing-use')).toHaveLength(1);
});

it('applies secret-use consent through next HTTP once, with answer/grant rollback and restart replay', async () => {
  const home = mkdtempSync(join(tmpdir(),'approval-secret-http-')); fixture(home);
  const clock = new FakeClock(1_800_000_000_000);
  const options = {home,next:true,staging:true,clock,stdout:()=>{}};
  let app = await startLoom(options);
  const token = randomUUID();
  signin(app).tokens.change(rows=>rows.push({role:'owner',member:'jonathan',sha256:hash(token),label:'fixture',created:new Date(clock.now()).toISOString()}));
  const post = async (piece:string,verb:string,input:object,id=randomUUID()) => (await fetch(`${app.url}/api/${piece}/${verb}`, {
    method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({input,id}),
  })).json();
  try {
    expect(await post('secrets','describe',{name:'api-key',description:''})).toMatchObject({ok:true});
    const requested = app.operations.call('direct',{kind:'agent',id:'pond-bot'},'secrets.requestHouse',
      {agent:'pond-bot',target:'api-key',scope:{house:'h-1'},why:'deploy',minutes:2},randomUUID());
    const card = value<{id:string}>(requested).id;
    await app.close(); app = await startLoom(options);
    const input = {id:card,answer:{kind:'yes'}}, receipt = randomUUID();
    const before = app.db.prepare('SELECT * FROM secrets_grants').all();
    app.db.exec("CREATE TRIGGER fail_secret_http BEFORE INSERT ON secrets_grants BEGIN SELECT RAISE(ABORT,'fixture'); END");
    expect(await post('attention','answer',input,receipt)).toMatchObject({ok:false});
    expect(app.db.prepare('SELECT * FROM secrets_grants').all()).toEqual(before);
    expect(await post('attention','get',{id:card})).toMatchObject({ok:true,value:{state:'open'}});
    app.db.exec('DROP TRIGGER fail_secret_http');
    const answered = await post('attention','answer',input,receipt); expect(answered).toMatchObject({ok:true});
    const grants = app.db.prepare('SELECT * FROM secrets_grants').all(); expect(grants).toHaveLength(1);
    await app.close(); app = await startLoom(options);
    expect(await post('attention','answer',input,receipt)).toEqual(answered);
    expect(await post('attention','answer',input)).toMatchObject({ok:false,code:'conflict'});
    expect(app.db.prepare('SELECT * FROM secrets_grants').all()).toEqual(grants);
  } finally { await app.close(); rmSync(home,{recursive:true,force:true}); }
});
