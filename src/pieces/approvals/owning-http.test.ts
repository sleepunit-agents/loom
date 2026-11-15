import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { FakeClock } from '../../core/index.js';
import { signin, hash } from '../../core/signin/index.js';

const value=<T>(result:import('../../core/index.js').Result):T=>{if(!result.ok)throw Error(result.message);return result.value as T;};

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
