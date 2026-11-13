import { mkdtempSync, mkdirSync, readFileSync, readdirSync, fsyncSync, openSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStdioServer } from '../../index.js';
import { closeAllBackends } from '../../backends/index.js';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { FakeClock } from '../clock.js';
import { HouseholdDatabase } from './document.js';
import { HouseholdRows } from './rows.js';
import { signin } from '../signin/index.js';
import { readContinuityHousehold } from '../../continuity/household.js';
import type { Viewer } from '../../policy.js';
vi.mock('../../backends/fastembed.js', () => ({ FastEmbedProvider: class { readonly dimensions = 384; async embed() { return new Array(384).fill(0.1); } async embedBatch(texts: string[]) { return texts.map(() => new Array(384).fill(0.1)); } } }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const homes: string[] = [], closes: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.mocked(openSync).mockImplementation(actualFs.openSync); vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync); vi.mocked(renameSync).mockImplementation(actualFs.renameSync); for (const close of closes.splice(0).reverse()) await close(); closeAllBackends(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const input = { agent: 'gabe', name: 'Gabe', purpose: 'You help with the garden.', voice: 'Warm and direct.', rules: 'Keep private things private.', ask: 'Ask before spending money.' };
async function setup() { const home = mkdtempSync(join(tmpdir(), 'loom-bootstrap-')); homes.push(home); fixture(home); const clock = new FakeClock(); const app = await startLoom({ home, clock, next: true }); closes.push(app.close); return { home, clock, app }; }
it('creates a portable context, publishes Live after commit and mints its first token separately without journaling the bearer', async () => {
  const { app, home } = await setup(), h = new HouseholdDatabase(app.db), before = h.document()!;
  const tokens = new HouseholdRows(app.db, 'tokens').entries(), projects = new HouseholdRows(app.db, 'projects').entries();
  const events: unknown[] = []; app.live.observe(changes => { if (changes.length) events.push({ changes, transaction: app.db.inTransaction }); });
  const made = app.operations.call('socket', owner, 'household.bootstrapAgent', input, 'create-gabe');
  const dir = join(home, 'agents', 'gabe');
  expect(made).toEqual({ ok: true, value: { agent: 'gabe', contextDir: dir, mcp: { command: 'loom', args: ['mcp', '--next', '--home', home, '--agent', 'gabe'] } } });
  expect(h.document()).toEqual({ ...before, agents: [...before.agents as string[], 'gabe'] });
  expect(new HouseholdRows(app.db, 'projects').entries()).toEqual(projects); expect(new HouseholdRows(app.db, 'tokens').entries()).toEqual(tokens);
  expect(readFileSync(join(dir, 'IDENTITY.md'), 'utf8')).toContain('# Gabe\n\nYou help with the garden.');
  for (const content of ['## Voice\n\nWarm and direct.', '## Rules\n\nKeep private things private.', '## When to ask first\n\nAsk before spending money.']) expect(readFileSync(join(dir, 'IDENTITY.md'), 'utf8')).toContain(content);
  expect(readFileSync(join(dir, 'preferences.md'), 'utf8')).toContain('# Gabe — Preferences');
  expect(readFileSync(join(dir, 'self-model.md'), 'utf8')).toContain('## Strengths');
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
  expect(events).toEqual([{ changes: [{ type: 'household.sharing', id: 'household' }, { type: 'core.access', id: 'household' }], transaction: false }]);
  const mint = app.operations.call('socket', owner, 'token.create', { role: 'agent', agent: 'gabe', label: 'gabe · first token' });
  if (!mint.ok) throw new Error('Mint failed'); const token = (mint.value as { token: string }).token;
  expect(signin(app).token(signinHash(token))?.viewer).toEqual({ kind: 'agent', id: 'gabe' });
  expect(JSON.stringify(app.db.prepare('SELECT * FROM core_operations').all())).not.toContain(token);
  await app.close();
  expect(readContinuityHousehold(home, 'gabe').agent).toBe('gabe');
  expect(readFileSync(join(dir, 'IDENTITY.md'), 'utf8')).toContain('garden');
  const bytes = readFileSync(join(home, 'loom.db'));
  const { server } = createStdioServer(['mcp', '--next', '--home', home, '--agent', 'gabe']);
  const client = new Client({ name: 'bootstrap-acceptance', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  closes.push(async () => { await client.close(); await server.close(); });
  await server.connect(a); await client.connect(b);
  const identity = await client.callTool({ name: 'identity', arguments: {} });
  expect(identity.isError).not.toBe(true);
  const words = JSON.stringify(identity.content);
  expect(words).toContain('Gabe'); expect(words).toContain('garden'); expect(words).toContain('Keep private things private.'); expect(words).toContain('Ask before spending money.');
  expect(words).toContain('jonathan');
  expect(readFileSync(join(home, 'loom.db'))).toEqual(bytes);
});
function signinHash(value: string) { return createHash('sha256').update(value).digest('hex'); }
import { createHash } from 'node:crypto';
it('refuses every nonowner and invalid or occupied path before creating files or rows', async () => {
  const { app, home } = await setup(), before = new HouseholdDatabase(app.db).document();
  for (const door of ['http', 'socket', 'mcp', 'direct'] as const) for (const viewer of [{ kind: 'member', id: 'pollock' }, { kind: 'agent', id: 'art' }, { kind: 'service', id: 'sharing' }, { kind: 'runner', id: 'box' }] as Viewer[]) expect(app.operations.call(door, viewer, 'household.bootstrapAgent', input, `${door}:${viewer.id}`)).toMatchObject({ code: 'denied' });
  expect(readdirSync(home)).not.toContain('agents');
  for (const change of [{ agent: '../outside' }, { agent: 'ART' }, { name: 'Bad\n# heading' }, { purpose: ' ' }, { voice: '' }, { force: true }]) expect(app.operations.call('direct', owner, 'household.bootstrapAgent', { ...input, ...change }, JSON.stringify(change))).toMatchObject({ code: 'invalid' });
  mkdirSync(join(home, 'agents', 'gabe'), { recursive: true }); writeFileSync(join(home, 'agents', 'gabe', 'IDENTITY.md'), 'Existing creed');
  expect(app.operations.call('http', owner, 'household.bootstrapAgent', input, 'occupied')).toMatchObject({ code: 'conflict' });
  expect(readFileSync(join(home, 'agents', 'gabe', 'IDENTITY.md'), 'utf8')).toBe('Existing creed');
  rmSync(join(home, 'agents', 'gabe'), { recursive: true }); symlinkSync(join(home, 'not-there'), join(home, 'agents', 'gabe'));
  expect(app.operations.call('direct', owner, 'household.bootstrapAgent', input, 'alias')).toMatchObject({ code: 'invalid' });
  rmSync(join(home, 'agents'), { recursive: true }); mkdirSync(join(home, 'elsewhere')); symlinkSync(join(home, 'elsewhere'), join(home, 'agents'));
  expect(app.operations.call('direct', owner, 'household.bootstrapAgent', input, 'parent-alias')).toMatchObject({ code: 'invalid' });
  expect(new HouseholdDatabase(app.db).document()).toEqual(before); expect(readdirSync(join(home, 'elsewhere'))).toEqual([]);
});
it('recovers the exact unchanged filesystem publication after SQLite rollback and restart; cannot replay a different request', async () => {
  const { app, home, clock } = await setup(), before = new HouseholdDatabase(app.db).document();
  const events: unknown[] = []; app.live.observe(c => { if (c.length) events.push(c); });
  app.db.exec("CREATE TRIGGER fail_bootstrap BEFORE INSERT ON core_operations WHEN NEW.id='create-gabe' BEGIN SELECT RAISE(ABORT,'retry failed'); END");
  expect(app.operations.call('direct', owner, 'household.bootstrapAgent', input, 'create-gabe')).toMatchObject({ code: 'unavailable' });
  expect(new HouseholdDatabase(app.db).document()).toEqual(before); expect(events).toEqual([]);
  const identity = readFileSync(join(home, 'agents', 'gabe', 'IDENTITY.md'));
  expect(app.operations.call('direct', owner, 'household.bootstrapAgent', input, 'different')).toMatchObject({ code: 'conflict' });
  app.db.exec('DROP TRIGGER fail_bootstrap'); await app.close();
  const reopened = await startLoom({ home, clock, next: true }); closes.push(reopened.close);
  const call = () => reopened.operations.call('direct', owner, 'household.bootstrapAgent', input, 'create-gabe');
  expect(call()).toMatchObject({ ok: true });
  writeFileSync(join(home, 'agents', 'gabe', 'preferences.md'), 'Later preferences');
  expect(call()).toMatchObject({ ok: true }); // committed receipt, no filesystem rewrite
  expect(readFileSync(join(home, 'agents', 'gabe', 'preferences.md'), 'utf8')).toBe('Later preferences');
  expect(readFileSync(join(home, 'agents', 'gabe', 'IDENTITY.md'))).toEqual(identity);
  expect(reopened.operations.call('direct', owner, 'household.bootstrapAgent', { ...input, purpose: 'Different' }, 'create-gabe')).toMatchObject({ code: 'conflict' });
});
it('refuses adoption when a rolled-back context was changed or replaced by a link', async () => {
  const { app, home } = await setup();
  app.db.exec("CREATE TRIGGER fail_bootstrap BEFORE INSERT ON core_operations WHEN NEW.id='create-gabe' BEGIN SELECT RAISE(ABORT,'retry failed'); END");
  expect(app.operations.call('direct', owner, 'household.bootstrapAgent', input, 'create-gabe')).toMatchObject({ code: 'unavailable' });
  app.db.exec('DROP TRIGGER fail_bootstrap');
  const path = join(home, 'agents', 'gabe', 'IDENTITY.md'); writeFileSync(path, 'Changed');
  expect(app.operations.call('direct', owner, 'household.bootstrapAgent', input, 'create-gabe')).toMatchObject({ code: 'conflict' });
  rmSync(path); symlinkSync(join(home, 'loom.db'), path);
  expect(app.operations.call('direct', owner, 'household.bootstrapAgent', input, 'create-gabe')).toMatchObject({ code: 'conflict' });
  expect(new HouseholdDatabase(app.db).household(home)?.agents).not.toContain('gabe');
});

it('flushes complete files before publication and retries a failed publication flush before registration', async () => {
  const { app, home } = await setup(), dirs = new Map<number, string>(), flushed: string[] = [];
  let fail = 'file';
  vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => { const fd = actualFs.openSync(...args); dirs.set(fd, String(args[0])); return fd; });
  vi.mocked(fsyncSync).mockImplementation(fd => {
    const path = dirs.get(fd)!;
    if (fail === 'file' && path.endsWith('IDENTITY.md')) throw new Error('file flush failed');
    if (fail === 'parent' && path === join(home, 'agents')) throw new Error('publication flush failed');
    flushed.push(path); actualFs.fsyncSync(fd);
  });
  vi.mocked(renameSync).mockImplementation((a, b) => {
    const source = String(a);
    expect(readdirSync(source).sort()).toEqual(['.loom-bootstrap.json', 'IDENTITY.md', 'preferences.md', 'self-model.md']);
    for (const name of readdirSync(source)) expect(flushed).toContain(join(source, name));
    expect(flushed).toContain(source);
    actualFs.renameSync(a, b);
  });
  const call = () => app.operations.call('direct', owner, 'household.bootstrapAgent', input, 'flush');
  expect(call()).toMatchObject({ code: 'unavailable' });
  expect(vi.mocked(renameSync)).not.toHaveBeenCalled(); expect(readdirSync(join(home, 'agents'))).toEqual([]);
  fail = 'parent'; expect(call()).toMatchObject({ code: 'unavailable' });
  expect(new HouseholdDatabase(app.db).household(home)?.agents).not.toContain('gabe');
  // Still failing the flush must also block recovery of the already published context.
  expect(call()).toMatchObject({ code: 'unavailable' });
  expect(new HouseholdDatabase(app.db).household(home)?.agents).not.toContain('gabe');
  fail = ''; flushed.length = 0;
  expect(call()).toMatchObject({ ok: true });
  expect(flushed.slice(-3)).toEqual([join(home, 'agents', 'gabe'), join(home, 'agents'), home]);
});
it('binds orphan recovery to the original authorized owner and compares exact bytes, not UTF-8 decoding', async () => {
  const { app, home } = await setup();
  app.db.transaction(() => new HouseholdDatabase(app.db).change(home, raw => {
    (raw.members as unknown[]).push({ person: 'other-owner', role: 'owner', agents: '*' });
  }))();
  app.db.exec("CREATE TRIGGER fail_bootstrap BEFORE INSERT ON core_operations WHEN NEW.id='bytes' BEGIN SELECT RAISE(ABORT,'retry failed'); END");
  const special = { ...input, purpose: 'Garden \ufffd' };
  const call = (viewer: Viewer = owner) => app.operations.call('direct', viewer, 'household.bootstrapAgent', special, 'bytes');
  expect(call()).toMatchObject({ code: 'unavailable' }); app.db.exec('DROP TRIGGER fail_bootstrap');
  expect(call({ kind: 'member', id: 'other-owner' })).toMatchObject({ code: 'conflict' });
  const file = join(home, 'agents', 'gabe', 'IDENTITY.md'), original = readFileSync(file);
  const altered = Buffer.concat([original.subarray(0, original.indexOf(Buffer.from('\ufffd'))), Buffer.from([0xff]), original.subarray(original.indexOf(Buffer.from('\ufffd')) + 3)]);
  expect(altered.toString('utf8')).toBe(original.toString('utf8')); expect(altered).not.toEqual(original);
  writeFileSync(file, altered);
  expect(call()).toMatchObject({ code: 'conflict' });
  expect(new HouseholdDatabase(app.db).household(home)?.agents).not.toContain('gabe');
  writeFileSync(file, original); expect(call()).toMatchObject({ ok: true });
});
