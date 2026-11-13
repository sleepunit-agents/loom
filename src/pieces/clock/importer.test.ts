import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile, exec, spawnSync, execSync, execFileSync } from 'node:child_process';
vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn(), exec: vi.fn(), spawnSync: vi.fn(), execSync: vi.fn(), execFileSync: vi.fn() }));
import { createFoundation } from '../../core/app.js';
import { mayAct } from '../../policy.js';
import { importClock } from './importer.js';
import { wakes, schedules } from './store.js';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'clock-import-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const from = join(dir, 'old'); mkdirSync(join(from, 'art'), { recursive: true }); mkdirSync(join(from, 'other'));
  const at = '2026-11-12 20:47:00', created = '2026-11-12 19:47:00';
  writeFileSync(join(from, 'art/filed.json'), JSON.stringify({ 'a-12345678': { prompt: 'Exact local work', note: 'exact' } }));
  writeFileSync(join(from, 'art/sessions.json'), JSON.stringify({ 'body-1': { state: 'running', continuation: 'opaque' } }));
  const source = [
    { id: 'w-111111', kind: 'prompt', at, created, prompt: 'Owner job', note: 'keep exact', for: 'owner', continuation: { opaque: 'sealed' }, fails: 2 },
    { id: 'w-222222', kind: 'schedule', schedule: 'night', at, created, prompt_file: 'routines/night.md', for: 'unknown', _firing: 'w-222222' },
    { id: 'w-333333', kind: 'parked', at, created, prompt: 'Continue after answer', on: 'a-12345678', until: '2026-11-13 19:47:00', for: 'person:guest' },
    { id: 'w-444444', kind: 'watch', at, created, house: 'house-1', wake: { id: 'w-111111' }, note: 'Watch old body' },
  ];
  writeFileSync(join(from, 'art/spool.jsonl'), source.map(r => JSON.stringify(r)).join('\n') + '\n');
  for (const agent of ['art','other']) writeFileSync(join(from, agent, 'schedules.json'), JSON.stringify({ B: { at: '03:47', prompt: 'Sort me' }, night: { at: ['01:37','22:47'], days: 'mon-fri', prompt_file: 'routines/night.md', note: 'night', for: 'owner' } }));
  writeFileSync(join(from, 'art/paused'), JSON.stringify({ since: created, by: 'owner' }));
  writeFileSync(join(from, 'lanes.json'), JSON.stringify({ night: { text: 'Exact lane words', agent: 'art' } }));
  writeFileSync(join(from, 'art/vouch.json'), JSON.stringify({ denied: ['w-333333'] }));
  writeFileSync(join(from, 'fire'), 'runtime\n');
  writeFileSync(join(from, 'art/wake.log'), '2026-11-12 19:47:00 fired w-000000\n');
  const app = createFoundation({ home: join(dir, 'new') }); cleanup.push(() => app.close());
  return { ...app, from, source, now: Date.parse('2026-11-13T02:47:00Z') };
}
it('preserves ids, content, pauses and opaque provenance without promoting legacy authority', () => {
  const f = fixture(), result = importClock(f.db, f.from, f.now);
  expect(result).toMatchObject({ imported: true, wakes: 4, schedules: 4 });
  const rows = wakes(f.db); expect(rows.map(w => w.id)).toEqual(f.source.map(w => w.id));
  for (const [i,w] of rows.entries()) { expect(w.legacy).toEqual(f.source[i]); expect(w.by).toEqual({ kind: 'runner', id: 'clock-import:unverified' }); expect(w.state).toBe('held'); expect(mayAct(w.by, { type: 'wake', agent: 'art' }, { members: {}, projects: {}, services: {} })).toBe(false); }
  expect(rows[0]).toMatchObject({ failures: 2, hold: 'provenance', prompt: 'Owner job' });
  expect(rows[1]).toMatchObject({ hold: 'uncertain', schedule: 'art/night' });
  expect(rows[2].wait).toMatchObject({ id: 'a-12345678' }); expect(rows[3].hold).toBe('uncertain');
  expect(schedules(f.db).map(s => [s.id, s.enabled])).toEqual([['art/B',false],['art/night',false],['other/B',false],['other/night',false]]);
  expect(f.db.prepare('SELECT agent FROM clock_pauses').all()).toEqual([{ agent: 'art' }]);
  const raw = f.db.prepare("SELECT value FROM clock_meta WHERE key='legacy-snapshot'").get() as { value: string };
  for (const path of ['art/vouch.json','art/filed.json','art/sessions.json','art/wake.log','lanes.json','fire']) expect(Buffer.from(JSON.parse(raw.value)[path], 'base64')).toEqual(readFileSync(join(f.from,path)));
  expect(importClock(f.db, f.from, f.now + 1000)).toMatchObject({ imported: false, checksum: result.checksum });
  writeFileSync(join(f.from,'art/wake.log'), 'different'); expect(() => importClock(f.db,f.from,f.now)).toThrow('different clock source');
});
it('rolls the schema, rows and marker back on interruption and compares written content', () => {
  const f = fixture();
  expect(() => importClock(f.db,f.from,f.now,{ interrupt() { throw new Error('power lost'); } })).toThrow('power lost');
  expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='clock_wakes'").get()).toBeUndefined();
  expect(() => importClock(f.db,f.from,f.now,{ interrupt() { f.db.prepare("UPDATE clock_wakes SET record='{}' WHERE id='w-111111'").run(); } })).toThrow('comparison failed');
  expect(importClock(f.db,f.from,f.now)).toMatchObject({ imported: true, wakes: 4 });
});
it('refuses duplicate ids, malformed source and symlinks without importing partial data', () => {
  const f = fixture(), path = join(f.from,'art/spool.jsonl'), original = readFileSync(path,'utf8');
  writeFileSync(path, original + JSON.stringify(f.source[0])); expect(() => importClock(f.db,f.from,f.now)).toThrow('Duplicate');
  writeFileSync(path,'{broken'); expect(() => importClock(f.db,f.from,f.now)).toThrow();
  writeFileSync(path,original); symlinkSync(path,join(f.from,'art/places.json')); expect(() => importClock(f.db,f.from,f.now)).toThrow('regular source file');
});
it('refuses an already populated destination without a marker', () => {
  const f = fixture(); importClock(f.db,f.from,f.now); f.db.prepare("DELETE FROM clock_meta WHERE key='source-checksum'").run();
  expect(() => importClock(f.db,f.from,f.now)).toThrow('destination must be empty');
});

it('preserves non-UTF8 archive bytes and refuses changed bytes that decode identically', () => {
  const f = fixture(), path = join(f.from,'art/wake.log'); writeFileSync(path, Buffer.from([0xff,0x00,0xfe]));
  importClock(f.db,f.from,f.now);
  const raw = f.db.prepare("SELECT value FROM clock_meta WHERE key='legacy-snapshot'").get() as { value: string };
  expect(Buffer.from(JSON.parse(raw.value)['art/wake.log'],'base64')).toEqual(Buffer.from([0xff,0x00,0xfe]));
  writeFileSync(path,Buffer.from([0xfe,0x00,0xff])); expect(() => importClock(f.db,f.from,f.now)).toThrow('different clock source');
});
it('refuses a changed source before any destination write', () => {
  const f = fixture();
  expect(() => importClock(f.db,f.from,f.now,{ afterSnapshot() { writeFileSync(join(f.from,'art/wake.log'),'changed'); } })).toThrow('changed during snapshot');
  expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='clock_wakes'").get()).toBeUndefined();
});
it('does not start jobs, run programs, or read prompt files during offline import', () => {
  const f = fixture(), timeout = vi.spyOn(globalThis,'setTimeout'), interval = vi.spyOn(globalThis,'setInterval');
  // The legacy prompt_file path is absent; following it would make this import fail.
  try {
    expect(importClock(f.db,f.from,f.now)).toMatchObject({ imported: true });
    expect(timeout).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled();
    for (const fn of [spawn,execFile,exec,spawnSync,execSync,execFileSync]) expect(fn).not.toHaveBeenCalled();
  } finally { timeout.mockRestore(); interval.mockRestore(); }
});
