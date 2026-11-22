import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {createDataSchema,dataDatabase} from '../data/database.js';
import {FakeClock} from '../clock.js';
import {requestWorkerAdmission} from './worker-join.js';

const fresh = () => ({request:randomUUID(),name:'wunder',fingerprint:randomBytes(32).toString('hex')});

it('retains the worker’s matching code across coordinator restarts until expiry', () => {
  const directory=mkdtempSync(join(tmpdir(),'loom-worker-join-'));
  const path=join(directory,'home.db');
  const clock=new FakeClock();
  const worker=fresh();
  let client=new Database(path);
  try {
    const result=requestWorkerAdmission(createDataSchema(client),clock,'local',worker);
    expect(result).toEqual({state:'pending',code:expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)});
    client.close();
    client=new Database(path);
    const db=dataDatabase(client);
    expect(requestWorkerAdmission(db,clock,'new-address',worker)).toEqual(result);
    clock.advance(15*60_000);
    expect(requestWorkerAdmission(db,clock,'local',worker)).toEqual({state:'expired'});
  } finally { if (client.open) client.close(); rmSync(directory,{recursive:true,force:true}); }
});

it('bounds new requests per source and household while accepting an existing worker poll', () => {
  const client=new Database(':memory:');
  try {
    const db=createDataSchema(client), clock=new FakeClock();
    const worker=fresh(), first=requestWorkerAdmission(db,clock,'one',worker);
    requestWorkerAdmission(db,clock,'one',fresh());
    expect(()=>requestWorkerAdmission(db,clock,'one',fresh())).toThrow(/too many/i);
    for(let i=0;i<18;i++) requestWorkerAdmission(db,clock,String(i),fresh());
    expect(()=>requestWorkerAdmission(db,clock,'another',fresh())).toThrow(/too many/i);
    expect(requestWorkerAdmission(db,clock,'one',worker)).toEqual(first);
    expect(()=>requestWorkerAdmission(db,clock,'one',{...worker,name:'renamed'})).toThrow(/different machine/);
  } finally { client.close(); }
});
