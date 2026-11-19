import Database from 'better-sqlite3';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {afterEach, expect, it} from 'vitest';
import {createDataSchema, dataSchemaNumber, recogniseDataSchema} from '../core/data/database.js';
import * as s from '../core/data/schema.js';
import {httpWorkerControl} from './worker-http.js';
import {workOnce, type WorkerExecutor} from './worker.js';
import {REPORT_MS} from './silence.js';

const start = Date.UTC(2026, 10, 18), token = 'r'.repeat(64);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

function seed(file: string, pendingMail: boolean) {
  const sqlite = new Database(file);
  const at = new Date(start).toISOString();
  try {
    const db = createDataSchema(sqlite, () => at);
    db.insert(s.members).values({id:'alice', role:'member', joinedAt:at}).run();
    db.insert(s.agents).values({id:'art', about:'', markBg:'#000', markFg:'#fff', faceShape:'pebble', faceEyes:'dot'}).run();
    db.insert(s.memberAgents).values({member:'alice', agent:'art'}).run();
    db.insert(s.boxes).values({id:'box', name:'Fixture', owner:'alice', sameMachineAsLoom:false, hostsAny:false, reportOnly:false, alwaysOn:false, enrolledAt:at}).run();
    db.insert(s.boxAgents).values({box:'box', agent:'art', lent:false}).run();
    db.insert(s.agentBoxes).values({agent:'art',box:'box',position:0}).run();
    db.insert(s.agentModels).values({agent:'art',model:'fixture',position:0}).run();
    db.insert(s.modelAccounts).values({id:'account',owner:'alice',provider:'fixture',label:'Fixture',hasRoom:true}).run();
    db.insert(s.modelAccountBoxes).values({account:'account',box:'box'}).run();
    db.insert(s.modelAccountWindows).values({account:'account',window:'week',usage:0.1,usageReadAt:at,resetsAt:new Date(start+7*86400000).toISOString(),durationMs:7*86400000}).run();
    db.insert(s.tokens).values({fingerprint:createHash('sha256').update(token).digest('hex'),label:'Runner',kind:'runner',box:'box',createdAt:at}).run();
    db.insert(s.conversations).values({id:'cv', agent:'art', member:'alice', venue:'loom',place:'thread', label:'Fixture', direct:true, startedAt:at,lastAt:at, turnCount:0}).run();
    db.insert(s.threads).values({id:'thread',conversation:'cv',title:'Fixture',titledBy:'member',pinned:false,openedAt:at,lastAt:at,readSeq:0,working:false,stopRequested:false}).run();
    db.insert(s.jobs).values({id:'job',agent:'art',member:'alice',conversation:'cv',title:'Fixture',state:'queued',brief:'',model:'fixture',startedByKind:'member',startedBy:'alice',houseRepository:'fixture',houseFile:'Housefile',houseBranch:'next',queuedAt:at}).run();
    if (pendingMail) db.insert(s.inbox).values({id:'mail',toKind:'agent',to:'art',conversation:'cv',source:'thread',sourceId:'thread',fromKind:'person',fromId:'alice',at,state:'waiting',job:'job',changedAt:at}).run();
  } finally { sqlite.close(); }
}

/** The first process exercises an actual claim and leaves the body running. Preserve that household
 * in the last shipped shape, as it would have been on disk at an upgrade. The replacement process
 * must recognise it, migrate it and accept the surviving worker and body's existing credentials. */
function leaveVersion14(file: string) {
  const sqlite = new Database(file);
  try {
    sqlite.transaction(() => {
      sqlite.exec(`
        DROP TABLE kit_uses;
        DROP TABLE project_outside_people;
        DROP TABLE agent_kit_outside_people;
        DROP TABLE agent_kit_members;
        DROP TABLE agent_kit_projects;
        DROP TABLE agent_kits;
        DELETE FROM migrations WHERE number = 15;
      `);
      expect(recogniseDataSchema(sqlite)).toBe(14);
    })();
  } finally { sqlite.close(); }
}

function fixtureProcess(name: string, directory: string, args: string[] = []) {
  const fixture = new URL('../../test/fixtures/restart-'+name+'.mjs', import.meta.url);
  const child = spawn(process.execPath, ['--import','tsx',fixture.pathname,...args], {
    cwd:new URL('../../', import.meta.url), env:{PATH:process.env.PATH, HOME:directory, TMPDIR:directory},
    stdio:['pipe','ignore','pipe','ipc'],
  });
  let errors = '';
  child.stderr!.on('data', chunk => {errors += String(chunk);});
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('close',resolve); child.once('error',reject);
  });
  const stop = async () => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); await exited; };
  cleanup.push(stop);
  const message = () => Promise.race([
    new Promise<unknown>(resolve => child.once('message',resolve)),
    exited.then(code => { throw Error(name+' exited '+code+' '+errors); }),
  ]);
  return {child, message, exited, stop, errors:() => errors};
}

it.each([
  {seconds:20, phase:'running', schema:false},
  {seconds:90, phase:'running', schema:true},
  {seconds:90, phase:'starting', schema:false},
  {seconds:20, phase:'tool', schema:false},
  {seconds:121, phase:'running', schema:false},
])('restarts the server after $seconds s with a job $phase (schema upgrade $schema)', async ({seconds,phase,schema}) => {
  const directory = mkdtempSync(join(tmpdir(),'loom-restart-'));
  cleanup.push(() => rmSync(directory,{recursive:true,force:true}));
  const file = join(directory,'household.sqlite'), overdue = seconds > 120;
  seed(file,overdue);
  let time = start;
  const serve = async (port: number, upgrade: boolean, hold = false) => {
    const server = fixtureProcess('server',directory,[file,String(port),String(time),upgrade?'upgrade':'existing',hold?'tool':'']);
    const address = await server.message();
    expect(typeof address).toBe('number');
    return {...server,port:Number(address)};
  };
  const first = await serve(0,false,phase === 'tool');
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const http = httpWorkerControl({url:'http://127.0.0.1:'+first.port,token,signal:abort.signal});
  const building = Promise.withResolvers<void>(), built = Promise.withResolvers<void>();
  const working = Promise.withResolvers<void>();
  let body: ReturnType<typeof fixtureProcess> | undefined;
  let builds = 0, starts = 0;
  const executor: WorkerExecutor = {
    async build() { builds++; building.resolve(); if (phase === 'starting') await built.promise; return 'fixture-image'; },
    start(_job, _build, signal) {
      starts++;
      const child = body = fixtureProcess('body',directory);
      signal.addEventListener('abort', () => {void child.stop();}, {once:true});
      const ready = child.message();
      return {
        acceptsBootstrap:true, spawned:Promise.resolve(),
        async release(input) {
          child.child.stdin!.end(JSON.stringify({origin:input!.origin,token:Buffer.from(input!.token).toString()}));
          expect(await ready).toBe('working'); working.resolve();
        },
        exited:child.exited.then(code => ({exitCode:code ?? 1,logTail:child.errors()})), stop:child.stop,
      };
    },
  };
  let tick!: () => void, report: Promise<boolean> | undefined;
  const control = {...http, repositoryInput:undefined,
    heartbeat(id:string,state:'starting'|'running',signal?:AbortSignal) { return report = http.heartbeat(id,state,signal); }};
  const run = workOnce({box:'box',control,executor,signal:abort.signal,now:() => time,
    schedule:{every(_ms,callback){tick=callback; return () => {};}}});
  async function reach(checkpoint: Promise<void>) {
    await Promise.race([checkpoint,run.then(result => {throw Error('Worker ended early: '+result+' '+(body?.errors() ?? ''));})]);
  }
  await reach(phase === 'starting' ? building.promise : working.promise);
  if (phase === 'tool') {
    const committed = first.message();
    body!.child.send('complete');
    await reach(committed.then(reply => {expect(reply).toBe('committed');}));
  }
  await first.stop();
  if (schema) leaveVersion14(file);
  for (let elapsed = 0; elapsed < seconds*1000; elapsed += REPORT_MS) {
    time = start + elapsed; report = undefined; tick();
    if (report) await Promise.resolve(report).catch(() => {});
    await nextTurn();
  }
  time = start + seconds*1000;
  const second = await serve(first.port,true);
  expect(second.child.pid).not.toBe(first.child.pid);
  if (overdue) {
    tick();
    expect(await run).toBe('abandoned');
    expect(await body!.exited).not.toBe(0);
    const swept = second.message();
    second.child.send({advance:150_000});
    expect(await swept).toBe('advanced');
  } else {
    report = undefined; tick(); if (report) await report;
    built.resolve(); await reach(working.promise);
    if (phase !== 'tool') body!.child.send('complete');
    expect(await run,body!.errors()).toBe('finished');
    expect(await body!.exited,body!.errors()).toBe(0);
  }
  expect([builds,starts]).toEqual([1,1]);
  const sqlite = new Database(file,{readonly:true});
  try {
    expect(sqlite.prepare('SELECT max(number) FROM migrations').pluck().get()).toBe(dataSchemaNumber);
    const rows = sqlite.prepare('SELECT id, state, retry_of FROM jobs ORDER BY rowid').all();
    if (overdue) expect(rows).toEqual([{id:'job', state:'lost',retry_of:null},{id:expect.any(String),state:'queued',retry_of:'job'}]);
    else {
      expect(rows).toEqual([{id:'job',state:'done',retry_of:null}]);
      expect(sqlite.prepare("SELECT count(*) FROM turns WHERE run='job' AND kind='reply'").pluck().get()).toBe(1);
      expect(sqlite.prepare("SELECT count(*) FROM messages WHERE thread='thread' AND run='job' AND kind='reply'").pluck().get()).toBe(1);
      expect(sqlite.prepare("SELECT id FROM operation_results WHERE operation='conversation.message'").pluck().all()).toEqual(['reply-receipt']);
    }
  } finally { sqlite.close(); }
});
