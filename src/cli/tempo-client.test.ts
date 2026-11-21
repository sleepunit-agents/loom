import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { datedWake } from '../core/tempo/calendar.js';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { agents, agentPauses, household, inbox, members, memberAgents, tokens, triggerLog, triggers } from '../core/data/schema.js';
import { sharedRoot } from '../shared-root.js';
import { runTempoClient } from './tempo-client.js';

it('finds earlier matching history of a stopped wake across pages, with the agent and time filters applied', async () => {
  const sql = new Database(':memory:');
  const clock = new FakeClock(Date.now());
  const at = new Date(clock.now()).toISOString();
  const db = createDataSchema(sql);
  const dir = mkdtempSync(join(tmpdir(), 'loom-wake-'));
  const file = join(dir, 'token');
  const token = randomUUID();
  writeFileSync(file, token, { mode: 0o600 });
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
  db.insert(tokens).values({ fingerprint: createHash('sha256').update(token).digest('hex'), label: 'fixture', kind: 'owner', member: 'owner', createdAt: at }).run();
  for (const id of ['fern', 'birch']) {
    db.insert(agents).values({ id, about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
    db.insert(memberAgents).values({ member: 'owner', agent: id }).run();
    db.insert(triggers).values({ id, ownerKind: 'agent', owner: id, sourceKind: 'time', lifespan: 'once', targetKind: 'inbox',
      toKind: 'agent', to: id, enabled: false, state: 'stopped', createdAt: at, changedAt: at, note: 'Example' }).run();
  }
  for (let seq = 1; seq <= 105; seq++) {
    db.insert(triggerLog).values({ seq, trigger: seq === 2 ? 'birch' : 'fern', event: seq <= 3 ? 'fired' : 'held',
      at: seq === 3 ? new Date(clock.now() - 7200000).toISOString() : at, note: 'entry ' + seq }).run();
  }
  const app = sharedRoot({ db, clock, originAllowed: () => true });
  try {
    let out = '', err = '';
    const io = { env: { WAKE_AGENT: 'fern', LOOM_URL: 'http://localhost', LOOM_TOKEN_FILE: file }, stdin: Readable.from([]),
      stdinIsTTY: false, stdout: (s:string) => { out += s; }, stderr: (s:string) => { err += s; } };
    const request: typeof fetch = (url, init) => Promise.resolve(app.http.request(String(url), init));
    const code = await runTempoClient(['log', '--grep', 'fire', '--since', '1h30m'], io, request);
    expect(code, err).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out).toMatch(/ \| fired \| fern entry 1\n$/);
    out = '';
    expect(await runTempoClient(['list'], io, request)).toBe(0);
    expect(out).toBe('No pending wakes.\n');
    const result = await app.http.request('/api/tempo/set', { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'request', input: { id: 'scheduled', ownerKind: 'household', sourceKind: 'time',
        times: at, lifespan: 'once', targetKind: 'inbox', toKind: 'agent', to: 'fern', instructions: 'Fixture', note: 'Fixture' } }),
    });
    expect(result.status, await result.text()).toBe(200);
    out = '';
    expect(await runTempoClient(['log', '--grep', 'delivered'], io, request)).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out).toMatch(/fired \| scheduled .* → delivered cv-[\w-]+/);
  } finally {
    await app.close();
    sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('replays creation and pause after lost responses and delivers once to the resumed agent', async () => {
  const client = new Database(':memory:');
  const clock = new FakeClock(Date.now());
  const db = createDataSchema(client);
  const at = new Date(clock.now()).toISOString();
  const dir = mkdtempSync(join(tmpdir(), 'loom-clock-control-'));
  const token = randomUUID();
  const file = join(dir, 'token');
  writeFileSync(file, token, { mode: 0o600 });
  db.insert(members).values({ id: 'director', role: 'owner', joinedAt: at }).run();
  db.insert(tokens).values({ fingerprint: createHash('sha256').update(token).digest('hex'),
    label: 'fixture', kind: 'owner', member: 'director', createdAt: at }).run();
  for (const id of ['fern', 'birch']) {
    db.insert(agents).values({ id, about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
    db.insert(memberAgents).values({ member: 'director', agent: id }).run();
  }
  const app = sharedRoot({ db, clock, originAllowed: () => true });
  try {
    let output = '', errors = '';
    const io = { env: { WAKE_LOCAL_AGENT: 'fern', LOOM_URL: 'http://localhost', LOOM_TOKEN_FILE: file },
      stdin: Readable.from([]), stdinIsTTY: false, stdout: (s: string) => { output += s; }, stderr: (s: string) => { errors += s; } };
    const attempts: string[] = [];
    const request: typeof fetch = async (url, init) => {
      const response = await app.http.request(String(url), init);
      attempts.push(String(init?.body));
      if (attempts.length === 1) {
        expect(response.status).toBe(200);
        await response.body?.cancel();
        throw Error('Simulated disconnect after commit');
      }
      return response;
    };
    const paused = () => db.select({ agent: agentPauses.agent }).from(agentPauses).orderBy(agentPauses.agent).all();
    for (const agent of ['fern', 'birch']) {
      const args = ['--agent', agent, 'in', '1m', '1s', '-p', 'Recheck the fixture', '--note', 'Fixture', '--model', 'normal'];
      expect(await runTempoClient(args, io, request), errors).toBe(0);
    }
    expect(attempts[0]).toBe(attempts[1]);
    expect(attempts[2]).not.toBe(attempts[1]);
    const scheduled = db.select().from(triggers).all();
    expect(scheduled).toHaveLength(2);
    expect(scheduled.map(row => row.to)).toEqual(['fern', 'birch']);
    expect(scheduled[0]).toMatchObject({ lifespan: 'once', instructions: 'Recheck the fixture', note: 'Fixture', wantsModel: 'normal' });
    attempts.length = 0;
    const recipients = () => db.select({ to: inbox.to }).from(inbox).all();
    expect(await runTempoClient(['pause'], io, request)).toBe(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
    expect(output).toContain("Paused fern's clock.");
    expect(paused()).toEqual([{ agent: 'fern' }]);
    expect(await runTempoClient(['--agent=birch', 'pause'], io, request)).toBe(0);
    clock.advance(Math.max(...scheduled.map(row => Date.parse(row.nextDueAt!))) - clock.now());
    expect(recipients()).toEqual([]);
    expect(await runTempoClient(['resume'], io, request)).toBe(0);
    expect(recipients()).toEqual([{ to: 'fern' }]);
    expect(paused()).toEqual([{ agent: 'birch' }]);
    expect(output).toContain("Resumed fern's clock.");
    expect(await runTempoClient(['at','tomorrow','9:30','-f','routines/check.md'], io, request)).toBe(0);
    expect(db.select().from(triggers).all().at(-1)).toMatchObject({ file:'routines/check.md', note:'routines/check.md', instructions:null });
    const fileWake = db.select().from(triggers).all().find(row => row.file === 'routines/check.md')!;
    expect(await runTempoClient(['--agent=birch','cancel',fileWake.id], io, request)).toBe(1);
    expect(await runTempoClient(['cancel',fileWake.id], io, request)).toBe(0);
    const standing = app.services.tempo.triggers.set({ id:'cadence@fern', ownerKind:'agent', owner:'fern',
      sourceKind:'time', times:'09:00', lifespan:'until-stopped', targetKind:'inbox', toKind:'agent', to:'fern', note:'Standing' });
    output = '';
    expect(await runTempoClient(['list'], io, request)).toBe(0);
    const occurrence = output.split('\n').find(line => line.includes('Standing'))!.split(' ')[0];
    expect(occurrence).toBe('cadence%40fern@' + standing.nextDueAt);
    expect(await runTempoClient(['cancel','cadence%40fern'], io, request)).toBe(1);
    attempts.length = 0;
    expect(await runTempoClient(['cancel',occurrence], io, request)).toBe(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
    const next = db.select().from(triggers).all().find(row => row.id === standing.id)!.nextDueAt;
    expect(Date.parse(next!)).toBeGreaterThan(Date.parse(standing.nextDueAt!));
    expect(await runTempoClient(['cancel',occurrence], io, request)).toBe(1);
    expect(db.select().from(triggers).all().find(row => row.id === standing.id)?.nextDueAt).toBe(next);
    const automatic = { ...io, env: { LOOM_URL: io.env.LOOM_URL, LOOM_TOKEN_FILE: file } };
    const beforeDefault = db.select().from(triggers).all().length;
    expect(await runTempoClient(['in','1h','-p','Work on it','--note','Auto'], automatic, request)).toBe(2);
    expect(db.select().from(triggers).all()).toHaveLength(beforeDefault);
    db.insert(household).values({defaultAgent:'birch'}).onConflictDoUpdate({target:household.singleton,set:{defaultAgent:'birch'}}).run();
    expect(await runTempoClient(['in','1h','-p','Work on it','--note','Auto'], automatic, request)).toBe(0);
    expect(db.select().from(triggers).all().find(row=>row.note==='Auto')).toMatchObject({owner:'birch',to:'birch'});
    const beforeHost = db.select().from(triggers).all().length;
    expect(await runTempoClient(['in','1h','-p','<!-- house: local --> do work','--note','Fixture'], io, request)).toBe(1);
    expect(db.select().from(triggers).all()).toHaveLength(beforeHost);
    const calls = attempts.length;
    expect(await runTempoClient(['resume', 'everything'], io, request)).toBe(2);
    expect(await runTempoClient(['in','1h','-p','No note'], io, request)).toBe(2);
    expect(await runTempoClient(['in','1h','-f','../private'], io, request)).toBe(2);
    expect(await runTempoClient(['in','1h','-f','routines/check.md','--continuation','handle'], io, request)).toBe(2);
    expect(attempts).toHaveLength(calls);
    writeFileSync(file, randomUUID());
    output = '';
    expect(await runTempoClient(['--agent=birch', 'resume'], io, request)).toBe(1);
    expect(attempts).toHaveLength(calls + 1);
    expect(output).toBe('');
    expect(errors).toContain('Loom rejected the credential.');
    expect(paused()).toEqual([{ agent: 'birch' }]);
  } finally {
    await app.close();
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('uses household calendar days across DST for dated and tomorrow wakes', () => {
  const zone = 'America/Chicago';
  const before = Date.parse('2026-03-08T05:45:00Z');
  expect(new Date(datedWake('tomorrow','09:30',before,zone)).toISOString()).toBe('2026-03-08T14:30:00.000Z');
  expect(() => datedWake('2026-03-08','02:30',before,zone)).toThrow();
  expect(() => datedWake('2026-02-30','10:30',before,zone)).toThrow();
  expect(new Date(datedWake('2026-11-01','01:30:45',before,zone)).toISOString()).toBe('2026-11-01T06:30:45.000Z');
});

it('lists named household lanes across pages and returns stored UTF-8 instructions with legacy newline handling', async () => {
  const sql = new Database(':memory:'), db = createDataSchema(sql), clock = new FakeClock();
  const at = new Date(clock.now()).toISOString(), folder = mkdtempSync(join(tmpdir(), 'loom-lanes-'));
  const file = join(folder, 'token'), owner = randomUUID(), agent = randomUUID();
  for (const id of ['fern', 'birch']) {
    db.insert(agents).values({id,about:'',markFg:'#fff',markBg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
  }
  db.insert(members).values({ id:'director', role:'owner', joinedAt:at }).run();
  db.insert(memberAgents).values({member:'director',agent:'fern'}).run();
  db.insert(tokens).values([
    {fingerprint:createHash('sha256').update(owner).digest('hex'),kind:'owner',label:'fixture',member:'director',createdAt:at},
    {fingerprint:createHash('sha256').update(agent).digest('hex'),kind:'agent',label:'agent fixture',agent:'fern',createdAt:at},
  ]).run();
  const words = '  Make a note 🎛️\r\n'.repeat(1024) + '\n';
  const lane = {ownerKind:'household',sourceKind:'time',times:'03:13',lifespan:'until-stopped',targetKind:'inbox',
    toKind:'agent',to:'fern',instructions:words,note:'Watch',enabled:true,state:'standing',createdAt:at,changedAt:at} as const;
  for (let i = 0; i < 103; i++) db.insert(triggers).values({...lane,id:'lane-'+i}).run();
  db.insert(triggers).values({...lane,id:'other',to:'birch',instructions:'No final newline'}).run();
  db.insert(triggers).values({...lane,id:'private-token',instructions:agent}).run();
  db.insert(triggers).values({...lane,id:'off',enabled:false,state:'stopped'}).run();
  const app = sharedRoot({db,clock,originAllowed:()=>true});
  try {
    const direct: typeof fetch = (url,init)=>Promise.resolve(app.http.request(String(url),init));
    let transport = direct;
    const run = async (credential:string, ...args:string[]) => {
      writeFileSync(file,credential,{mode:0o600});
      let out = '', err = '';
      const code = await runTempoClient(args, {env:{LOOM_URL:'http://localhost',LOOM_TOKEN_FILE:file},
        stdin:Readable.from([]),stdinIsTTY:false,stdout:s=>{out+=s;},stderr:s=>{err+=s;}},
        transport);
      return {code,out,err};
    };
    const listed = await run(owner,'lane','list');
    expect(listed.code,listed.err).toBe(0);
    const names = listed.out.trimEnd().split('\n').map(line=>line.split(' ')[0]);
    expect(names).toHaveLength(105);
    expect(new Set(names).size).toBe(105);
    expect(names).toContain('other');
    expect(names).not.toContain('off');
    expect(await run(owner,'lane','text','other')).toMatchObject({code:0,out:'No final newline\n'});
    expect(await run(agent,'lane','text','lane-102')).toMatchObject({code:0,out:words});
    expect(await run(agent,'--agent=birch','lane','text','other')).toMatchObject({code:1,out:''});
    expect(await run(agent,'lane','text','private-token')).toMatchObject({code:1,out:''});
    const source = join(folder,'routine.md');
    const update = '\uFEFFEdited instructions 🎛️\r\n\n';
    writeFileSync(source,update);
    const attempts: string[] = [];
    transport = async (url,init) => {
      const response = await direct(url,init);
      if (new URL(String(url)).pathname === '/api/tempo/edit') {
        attempts.push(String(init?.body));
        if (attempts.length === 1) {
          expect(response.status,await response.text()).toBe(200);
          throw Error('Lost acknowledgement');
        }
      }
      return response;
    };
    const applied = await run(owner,'lane','set','lane-102','-f',source);
    expect(applied.code,applied.err).toBe(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
    expect(await run(owner,'lane','text','lane-102')).toMatchObject({code:0,out:update});
    expect(db.select().from(triggers).all().find(row=>row.id==='lane-102')).toMatchObject({times:'03:13',to:'fern',note:'Watch',enabled:true});
    const firstEdit = JSON.parse(attempts[0]);
    const denied = await app.http.request('/api/tempo/edit',{method:'POST',headers:{
      'content-type':'application/json',authorization:'Bearer '+agent,
    },body:JSON.stringify({id:randomUUID(),input:firstEdit.input})});
    expect(denied.status).toBe(403);
    expect(await run(agent,'lane','set','lane-102','-p','Another edit')).toMatchObject({code:1,out:''});
    transport = async (url,init) => {
      if (new URL(String(url)).pathname === '/api/tempo/edit') {
        app.services.tempo.triggers.edit('lane-102',{instructions:'Concurrent text'},{kind:'member',id:'director'});
      }
      return direct(url,init);
    };
    expect(await run(owner,'lane','set','lane-102','-p','Stale update')).toMatchObject({code:1,out:'',err:expect.stringContaining('changed')});
    expect(await run(owner,'lane','text','lane-102')).toMatchObject({code:0,out:'Concurrent text\n'});

  } finally {
    await app.close(); sql.close(); rmSync(folder,{recursive:true,force:true});
  }
});
