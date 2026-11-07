/**
 * The nightly backup (docs/specs/keeping-watch.md, "1. The nightly backup", "What the tests must pin"): settings and the
 * drill key; a run to a directory and to a git repo (split, one commit, kept nights); the drill's one retry; required
 * piece parts; a target that isn't the backup's refused; when it's due; the lock; the Inbox alert and Setup's row; the
 * owner's alert command. Needs `age` and `git` (CI installs age).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { loadHousehold, rawHousehold, type Household } from './household.js';
import {
  alertCommandArgv, backupFyi, backupProblem, postBufferFor, gitFailure, parseTarget, scrub, backupRow, BackupError, ensureDrillKey, isDue, keptStamps, lastSlot, readSettings, readState, runBackup,
  setSettings, stampOf, takeLock, tickBackup, validateSettings, type CoreAlert, type RunDeps,
} from './backup.js';
import { backupAsks } from './ui/handler.js';
import { agentSetup, householdAct } from './ui/household-pages.js';
import type { DrillReport, Manifest } from './bundle.js';
import { runCli } from './cli/index.js';
import { ENTRY, spawnBackupTick } from './backup-tick.js';
import { Readable } from 'node:stream';
import { remember } from './tools/remember.js';
import { closeAllBackends } from './backends/index.js';

const which = (name: string) => (spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf-8' }).stdout || '').trim();
const AGE = which('age');
const AGE_KEYGEN = which('age-keygen');
const hasTools = AGE !== '' && AGE_KEYGEN !== '' && which('git') !== '';
const sealedHome = mkdtempSync(join(tmpdir(), 'loom-backup-home-'));

function keypair(dir: string, name: string): { identity: string; recipient: string } {
  const identity = join(dir, `${name}.key`);
  const r = spawnSync(AGE_KEYGEN, ['-o', identity], { encoding: 'utf-8' });
  return { identity, recipient: (r.stderr + r.stdout).match(/age1[0-9a-z]+/)![0] };
}

const git = (args: string[], cwd?: string) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

describe.skipIf(!hasTools)('loom backup', () => {
  let work: string;
  let h: Household;
  let env: NodeJS.ProcessEnv;
  let owner: { identity: string; recipient: string };
  let alerts: CoreAlert[];

  beforeEach(async () => {
    work = mkdtempSync(join(tmpdir(), 'loom-backup-'));
    const home = join(work, 'home');
    mkdirSync(join(home, 'agents', 'art'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# Art E Fish\n\nI am Art.\n');
    chmodSync(home, 0o700);
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', owner: 'jonathan' }), { mode: 0o600 });
    h = loadHousehold(home)!;
    await remember(join(home, 'agents', 'art'), { category: 'project', title: 'zebra kiln', content: 'only art knows the zebra kiln' });
    await closeAllBackends();
    const { LOOM_HOME: _h, LOOM_CONTEXT_DIR: _c, LOOM_ALERT_COMMAND: _a, ...rest } = process.env;
    env = { ...rest, HOME: sealedHome, LOOM_AGE: AGE, LOOM_AGE_KEYGEN: AGE_KEYGEN, PATH: ['/usr/bin', '/bin', ...(process.env.PATH ?? '').split(delimiter)].join(delimiter),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    owner = keypair(work, 'owner');
    alerts = [];
  });

  afterEach(async () => {
    await closeAllBackends();
    rmSync(work, { recursive: true, force: true });
  });

  const settings = (target: string, extra: Record<string, unknown> = {}) =>
    setSettings(h, validateSettings({ target, recipients: [owner.recipient], at: '02:55', tz: 'America/Chicago', ...extra }), env);

  /**
   * Noon in Chicago, well clear of the 02:55 slot. The tick tests count from setAt, and setAt is the wall clock when
   * settings were set: left there, a run in a ten-minute window each day (02:45-02:55 in Chicago for the first tick
   * test, 20:45-20:55 for the miss) put the slot between two of its ticks, and the tick ran a backup the test didn't
   * expect (t-1925: loom#589's 22.x job ran at 02:40-03:01 UTC, twice).
   */
  const NOON_CHICAGO = '2026-11-04T18:00:00.000Z';
  const pinSetAt = (iso: string): number => {
    writeFileSync(join(h.home, 'backup', 'state.json'), JSON.stringify({ ...readState(h.home), setAt: iso }));
    return Date.parse(iso);
  };

  /** An export that writes `bytes` random bytes and says these pieces were in; a drill that answers from `drills`. */
  function fakes(o: { bytes?: number; pieces?: string[]; drills?: boolean[]; exported?: { n: number } } = {}): RunDeps {
    const drills = [...(o.drills ?? [true, true, true])];
    return {
      alert: (_e, a) => { alerts.push(a); return true; },
      exportBundle: async ({ to }) => {
        if (o.exported) o.exported.n++;
        writeFileSync(to, Buffer.from(Array.from({ length: o.bytes ?? 2500 }, (_, i) => (i * 7 + (o.exported?.n ?? 0)) % 251)));
        return { v: 1, loom: 't', created: new Date().toISOString(), household: { agents: ['art'], default: 'art' },
          pieces: (o.pieces ?? []).map((name) => ({ name, included: true, bytes: 1, sha256: 'x' })) } as Manifest;
      },
      drillBundle: async () => {
        const ok = drills.shift() ?? true;
        return { ok, manifest: {} as Manifest, differences: ok ? [] : [{ what: 'art.memories', live: 2, restored: 1 }] } as DrillReport;
      },
    };
  }

  // ─── Settings ──────────────────────────────────────────────────────────────

  it('set stores the settings in household.json and makes a 0600 drill key once', () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    const a = settings(`path:${dir}`);
    expect(rawHousehold(h.home).backup).toEqual({ target: `path:${dir}`, recipients: [owner.recipient], at: '02:55', tz: 'America/Chicago', keep: 7 });
    expect(() => settings(`path:${dir}`, { recipients: [a.drillRecipient] })).toThrow(/drill key/);
    const key = join(h.home, 'backup', 'drill.key');
    expect(statSync(key).mode & 0o777).toBe(0o600);
    const b = settings(`path:${dir}`, { keep: 3 });
    expect(b.drillRecipient).toBe(a.drillRecipient);
    expect(readSettings(h).settings?.keep).toBe(3);
  });

  it('refuses a recipient that isn\'t a public key, a target that isn\'t git: or path:, and an at that isn\'t HH:MM', () => {
    const ok = { target: 'path:/mnt/x', recipients: [owner.recipient] };
    expect(() => validateSettings({ ...ok, recipients: ['AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQ'] })).toThrow(BackupError);
    expect(() => validateSettings({ ...ok, recipients: [] })).toThrow(/at least one/);
    expect(() => validateSettings({ ...ok, target: 'https://github.com/x/y' })).toThrow(/git:<url> or path:/);
    expect(() => validateSettings({ ...ok, target: 'path:relative/dir' })).toThrow(/absolute/);
    expect(() => validateSettings({ ...ok, target: 'git:--upload-pack=evil' })).toThrow(BackupError);
    expect(() => validateSettings({ ...ok, at: '3am' })).toThrow(/HH:MM/);
    expect(() => validateSettings({ ...ok, at: '24:00' })).toThrow(/HH:MM/);
    expect(() => validateSettings({ ...ok, tz: 'Mars/Olympus' })).toThrow(/time zone/);
    expect(validateSettings(ok)).toMatchObject({ at: '03:00', keep: 7 });
  });

  it('a target URL with credentials in it is refused; git\'s words never carry userinfo or the target URL', () => {
    expect(() => parseTarget('git:https://u:p@github.com/x/y.git')).toThrow(/carries no credentials/);
    expect(() => parseTarget('git:https://ghp_abcdefghijklmnop@github.com/x/y.git')).toThrow(/carries no credentials/);
    expect(() => parseTarget('git:ssh://u:p@host/x.git')).toThrow(/carries no credentials/);
    expect(parseTarget('git:ssh://git@github.com/x/y.git')).toEqual({ kind: 'git', url: 'ssh://git@github.com/x/y.git' });
    expect(parseTarget('git:git@github.com:x/y.git')).toEqual({ kind: 'git', url: 'git@github.com:x/y.git' });
    const said = gitFailure('push', "remote: denied\nfatal: unable to access 'https://u:p@host/org/repo.git/': 403", 'https://github.com/x/backups.git');
    expect(said).not.toMatch(/u:p/);
    expect(said).toMatch(/https:\/\/\*\*\*@host/);
    expect(scrub('fatal: could not read from https://github.com/x/backups.git', 'https://github.com/x/backups.git')).toBe('fatal: could not read from <target backups>');
    expect(scrub('see http://tok@a.b/c and https://x:y@z/w')).toBe('see http://***@a.b/c and https://***@z/w');
    expect(scrub("fatal: unable to access 'https://u:p@ss@host/org/repo.git/'")).toBe("fatal: unable to access 'https://***@host/org/repo.git/'");
    expect(gitFailure('push', 'https://u:p@ss@w@host/x', undefined)).not.toMatch(/ss@|p@|w@host/);
  });

  it('a git failure in a run reaches the state and the alert without userinfo', async () => {
    const remote = join(work, 'remote.git');
    git(['init', '-q', '--bare', remote]);
    settings(`git:${remote}`);
    // Point origin of loom's clone somewhere that fails with a URL holding userinfo in git's own words.
    const deps = fakes();
    const run0 = await runBackup({ home: h.home, env, deps });
    expect(run0.ok).toBe(true);
    git(['--git-dir', join(h.home, 'backup', 'repo.git'), 'config', 'remote.origin.pushurl', 'https://user:sekrit@127.0.0.1:1/x.git']);
    const run = await runBackup({ home: h.home, env, now: () => new Date(Date.now() + 86_400_000), deps });
    expect(run.ok).toBe(false);
    expect(JSON.stringify(readState(h.home))).not.toMatch(/sekrit/);
    expect(JSON.stringify(alerts)).not.toMatch(/sekrit/);
  });

  it('a path inside $LOOM_HOME is refused', () => {
    expect(() => settings(`path:${join(h.home, 'backup')}`)).toThrow(/inside loom's home/);
    expect(() => settings(`path:${h.home}`)).toThrow(/inside loom's home/);
  });

  it('a restored household (settings, no setAt here) never runs or pushes, and has no Inbox alert', async () => {
    const remote = join(work, 'remote.git');
    git(['init', '-q', '--bare', remote]);
    writeFileSync(join(h.home, 'household.json'), JSON.stringify({ ...rawHousehold(h.home), backup: { target: `git:${remote}`, recipients: [owner.recipient], at: '02:55', tz: 'UTC', keep: 7 } }));
    const exported = { n: 0 };
    expect(await tickBackup({ home: h.home, env, nowMs: Date.now() + 3 * 86_400_000, deps: fakes({ exported }) })).toBe('not-set');
    const run = await runBackup({ home: h.home, env, deps: fakes({ exported }) });
    expect(run.why).toMatch(/restored here/);
    expect(exported.n).toBe(0);
    expect(git(['--git-dir', remote, 'for-each-ref'])).toBe('');
    expect(backupAsks(h, Date.now() + 3 * 86_400_000)).toEqual([]);
    expect(backupRow(h)).toMatchObject({ text: 'waiting', tone: 'warn' });
  });

  // ─── A run to a directory, with the real export and drill ─────────────────

  it('a run to a directory writes a bundle the owner\'s key and the drill key both open, holding no drill.key', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    const run = await runBackup({ home: h.home, env, deps: { alert: (_e, a) => { alerts.push(a); return true; } } });
    expect(run.why).toBeUndefined();
    expect(run).toMatchObject({ ok: true, drill: { ok: true, tries: 1 } });
    const bundle = join(dir, run.name!);
    expect(existsSync(join(dir, '.loom-backup'))).toBe(true);
    expect(readFileSync(join(dir, 'RESTORE.md'), 'utf-8')).toMatch(/loom restore/);
    const drillKey = join(h.home, 'backup', 'drill.key');
    for (const id of [owner.identity, drillKey]) {
      const out = join(work, `plain-${id.length}.tar`);
      expect(spawnSync(AGE, ['-d', '-i', id, '-o', out, bundle]).status).toBe(0);
      const list = spawnSync('tar', ['-tzf', out], { encoding: 'utf-8' }).stdout;
      expect(list).toMatch(/agents\/art\/memories\.db/);
      expect(list).not.toMatch(/drill\.key/);
    }
    expect(readState(h.home).lastGood?.name).toBe(run.name);
    expect(alerts).toEqual([]);
  });

  it('an agent\'s own file named drill.key is its data: the backup still runs, and loom\'s own drill key isn\'t in it', async () => {
    writeFileSync(join(h.home, 'agents', 'art', 'drill.key'), 'not the drill key');
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    const run = await runBackup({ home: h.home, env, deps: { alert: (_e, a) => { alerts.push(a); return true; } } });
    expect(run.why).toBeUndefined();
    const out = join(work, 'plain.tar');
    expect(spawnSync(AGE, ['-d', '-i', owner.identity, '-o', out, join(dir, run.name!)]).status).toBe(0);
    const list = spawnSync('tar', ['-tzf', out], { encoding: 'utf-8' }).stdout.split('\n');
    expect(list).toContain('./agents/art/drill.key');
    expect(list.filter((l) => l.includes('backup/'))).toEqual([]);
  });

  it('a drill that throws pushes nothing, and doesn\'t retry', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    let drills = 0;
    const run = await runBackup({ home: h.home, env, deps: { ...fakes(), drillBundle: async () => { drills++; throw new Error('age (decrypt: is this the right key?) failed'); } } });
    expect(run.ok).toBe(false);
    expect(run.why).toMatch(/right key/);
    expect(drills).toBe(1);
    expect(readdirSync(dir).filter((n) => n.endsWith('.bundle'))).toEqual([]);
  });

  // ─── The drill's one retry, and required parts ────────────────────────────

  it('a drill that mismatches once then passes is written; twice, nothing is, and the state says why', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    const exported = { n: 0 };
    const once = await runBackup({ home: h.home, env, deps: fakes({ drills: [false, true], exported }) });
    expect(once).toMatchObject({ ok: true, drill: { ok: true, tries: 2 } });
    expect(exported.n).toBe(2);
    rmSync(join(dir, once.name!));
    const twice = await runBackup({ home: h.home, env, now: () => new Date(Date.now() + 120_000), deps: fakes({ drills: [false, false] }) });
    expect(twice.ok).toBe(false);
    expect(twice.why).toMatch(/drill didn't match .* twice \(art\.memories\); nothing was written/);
    expect(readdirSync(dir).filter((n) => n.endsWith('.bundle'))).toEqual([]);
    expect(readState(h.home).runs[0]).toMatchObject({ ok: false, drill: { ok: false, tries: 2, differences: ['art.memories'] } });
    expect(alerts.map((a) => [a.source, a.severity])).toEqual([['loom-backup', 'bad']]);
  });

  it('a piece part that was in the last good bundle and is missing now: written, and the run fails naming it', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    expect((await runBackup({ home: h.home, env, deps: fakes({ pieces: ['box', 'secrets'] }) })).ok).toBe(true);
    const later = new Date(Date.now() + 86_400_000);
    const run = await runBackup({ home: h.home, env, now: () => later, deps: { ...fakes({ pieces: ['secrets'] }), installedPieces: () => ['box', 'secrets'] } });
    expect(run.ok).toBe(false);
    expect(run.missing).toEqual(['box']);
    expect(run.why).toMatch(/without box's part/);
    expect(existsSync(join(dir, run.name!))).toBe(true);
    // The last good one stays the one with the box's part, so tomorrow's is held to it too.
    expect(readState(h.home).lastGood?.pieces).toEqual(['box', 'secrets']);
    const next = await runBackup({ home: h.home, env, now: () => new Date(later.getTime() + 86_400_000), deps: { ...fakes({ pieces: ['secrets'] }), installedPieces: () => ['box', 'secrets'] } });
    expect(next).toMatchObject({ ok: false, missing: ['box'] });
    // Uninstalled: not required any more.
    const gone = await runBackup({ home: h.home, env, now: () => new Date(later.getTime() + 2 * 86_400_000), deps: { ...fakes({ pieces: ['secrets'] }), installedPieces: () => ['secrets'] } });
    expect(gone.ok).toBe(true);
  });

  it('required pieces are a floor: a fresh machine\'s first run without one fails', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`, { required: ['box', 'secrets'] });
    const run = await runBackup({ home: h.home, env, deps: { ...fakes({ pieces: ['secrets'] }), installedPieces: () => [] } });
    expect(run).toMatchObject({ ok: false, missing: ['box'] });
    expect(readState(h.home).lastGood).toBeUndefined();
    expect(() => validateSettings({ target: 'path:/x', recipients: [owner.recipient], required: ['Bad Name'] })).toThrow(/names a piece/);
  });

  // ─── A git target ─────────────────────────────────────────────────────────

  it('a git target: split parts that rejoin, one commit after every run, the newest nights and each month\'s first kept', async () => {
    const remote = join(work, 'remote.git');
    git(['init', '-q', '--bare', remote]);
    settings(`git:${remote}`, { keep: 2 });
    const days = ['2026-10-01T09:00:00Z', '2026-10-02T09:00:00Z', '2026-10-03T09:00:00Z', '2026-10-04T09:00:00Z'];
    const runs = [];
    for (const d of days) {
      const run = await runBackup({ home: h.home, env, now: () => new Date(d), deps: { ...fakes({ bytes: 2500 }), splitAt: 1000 } });
      expect(run.why).toBeUndefined();
      runs.push(run);
      expect(git(['--git-dir', remote, 'rev-list', '--count', 'main'])).toBe('1');
    }
    expect(runs[0].parts).toBe(3);
    const files = git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).split('\n');
    const stamps = [...new Set(files.filter((f) => f.startsWith('bundles/')).map((f) => f.slice(23, 36)))].sort();
    // The 1st of the month (the first one), and the newest two nights.
    expect(stamps).toEqual(['20261001-0400', '20261003-0400', '20261004-0400']);
    expect(files).toEqual(expect.arrayContaining(['.loom-backup', 'RESTORE.md']));
    // The parts, joined, are the bundle the run wrote.
    const parts = files.filter((f) => f.startsWith('bundles/loom-household-20261004-0400.bundle.part-')).sort();
    expect(parts).toHaveLength(3);
    const joined = Buffer.concat(parts.map((p) => spawnSync('git', ['--git-dir', remote, 'show', `main:${p}`]).stdout));
    expect(joined.length).toBe(2500);
    // Byte for byte the file the run drilled (the fake export's bytes for that night).
    expect(joined.equals(Buffer.from(Array.from({ length: 2500 }, (_, i) => (i * 7) % 251)))).toBe(true);
    expect(readState(h.home).lastGood?.commit).toBe(git(['--git-dir', remote, 'rev-parse', 'main']));
   }, 30_000);

  it('the push is one sized POST: http.postBuffer on the push itself, sized to the night\'s bundle', async () => {
    const remote = join(work, 'remote.git');
    git(['init', '-q', '--bare', remote]);
    settings(`git:${remote}`);
    // A git that writes down each argv, then is git.
    const bin = join(work, 'bin'); mkdirSync(bin);
    const log = join(work, 'git-argv.log');
    const real = which('git');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexec ${real} "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const run = await runBackup({ home: h.home, env: { ...env, PATH: `${bin}${delimiter}${env.PATH}` }, deps: fakes({ bytes: 3000 }) });
    expect(run.ok).toBe(true);
    const lines = readFileSync(log, 'utf-8').split('\n');
    const push = lines.filter((l) => / push /.test(l));
    expect(push).toHaveLength(1);
    expect(push[0]).toMatch(new RegExp(`-c http\\.postBuffer=${postBufferFor(3000)} push`));
    expect(lines.filter((l) => /postBuffer/.test(l))).toHaveLength(1);
    expect(postBufferFor(3000)).toBe(3000 + 16 * 1024 * 1024);
    expect(postBufferFor(10 * 1024 ** 3)).toBe(512 * 1024 * 1024);
  });

  it('a run from a fresh clone (a new or restored machine) keeps the bundles already in the remote', async () => {
    const remote = join(work, 'remote.git');
    git(['init', '-q', '--bare', remote]);
    settings(`git:${remote}`, { keep: 3 });
    for (const d of ['2026-10-02T09:00:00Z', '2026-10-03T09:00:00Z']) expect((await runBackup({ home: h.home, env, now: () => new Date(d), deps: fakes() })).ok).toBe(true);
    rmSync(join(h.home, 'backup', 'repo.git'), { recursive: true, force: true });
    const run = await runBackup({ home: h.home, env, now: () => new Date('2026-10-04T09:00:00Z'), deps: fakes() });
    expect(run.why).toBeUndefined();
    const files = git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).split('\n').filter((f) => f.startsWith('bundles/'));
    expect(files).toEqual(['bundles/loom-household-20261002-0400.bundle', 'bundles/loom-household-20261003-0400.bundle', 'bundles/loom-household-20261004-0400.bundle']);
    expect(git(['--git-dir', remote, 'rev-list', '--count', 'main'])).toBe('1');
  });

  it('a target holding files loom didn\'t write is refused before export', async () => {
    const remote = join(work, 'theirs.git');
    git(['init', '-q', '--bare', remote]);
    const clone = join(work, 'clone');
    git(['clone', '-q', remote, clone]);
    writeFileSync(join(clone, 'PRIME'), 'a lease\n');
    git(['-c', 'user.name=x', '-c', 'user.email=x@x', 'add', 'PRIME'], clone);
    git(['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'theirs'], clone);
    git(['push', '-q', 'origin', 'HEAD:main'], clone);
    settings(`git:${remote}`);
    const exported = { n: 0 };
    const run = await runBackup({ home: h.home, env, deps: fakes({ exported }) });
    expect(run.ok).toBe(false);
    expect(run.why).toMatch(/files loom didn't write/);
    expect(exported.n).toBe(0);
    expect(git(['--git-dir', remote, 'ls-tree', '--name-only', 'main'])).toBe('PRIME');

    const other = join(work, 'other.git');
    git(['init', '-q', '--bare', other]);
    git(['push', '-q', other, 'HEAD:refs/heads/trunk'], clone);
    settings(`git:${other}`);
    expect((await runBackup({ home: h.home, env, deps: fakes({ exported }) })).why).toMatch(/branches but no main/);
    expect(exported.n).toBe(0);

    const dir = join(work, 'nas'); mkdirSync(dir); writeFileSync(join(dir, 'photos.txt'), 'x');
    settings(`path:${dir}`);
    expect((await runBackup({ home: h.home, env, deps: fakes({ exported }) })).why).toMatch(/files loom didn't write/);
    expect(exported.n).toBe(0);
    settings(`path:${join(work, 'not-mounted')}`);
    expect((await runBackup({ home: h.home, env, deps: fakes({ exported }) })).why).toMatch(/isn't a directory/);
  });

  // ─── When, and only one ───────────────────────────────────────────────────

  it('due: not before at in tz, once a day', () => {
    const s = { at: '02:55', tz: 'America/Chicago' };
    // 2026-11-04 02:55 CST is 08:55 UTC.
    expect(new Date(lastSlot(s, Date.parse('2026-11-04T09:00:00Z'))).toISOString()).toBe('2026-11-04T08:55:00.000Z');
    expect(new Date(lastSlot(s, Date.parse('2026-11-04T08:50:00Z'))).toISOString()).toBe('2026-11-03T08:55:00.000Z');
    // In summer it's CDT: 07:55 UTC.
    expect(new Date(lastSlot(s, Date.parse('2026-07-04T12:00:00Z'))).toISOString()).toBe('2026-07-04T07:55:00.000Z');
    expect(isDue(s, { runs: [] }, Date.parse('2026-11-04T09:00:00Z'))).toBe(true);
    expect(isDue(s, { lastStart: '2026-11-04T08:56:00Z', runs: [] }, Date.parse('2026-11-04T20:00:00Z'))).toBe(false);
    expect(isDue(s, { lastStart: '2026-11-04T08:56:00Z', runs: [] }, Date.parse('2026-11-05T08:54:00Z'))).toBe(false);
    expect(isDue(s, { lastStart: '2026-11-04T08:56:00Z', runs: [] }, Date.parse('2026-11-05T08:56:00Z'))).toBe(true);
    expect(stampOf(Date.parse('2026-11-04T08:55:00Z'), 'America/Chicago')).toBe('20261104-0255');
    expect([...keptStamps(['20261001-0400', '20261015-0400', '20261102-0400', '20261103-0400'], 1)].sort()).toEqual(['20261001-0400', '20261102-0400', '20261103-0400']);
  });

  it('a night whose run failed is tried again an hour after it ended, three tries at most; a good one isn\'t', () => {
    const s = { at: '02:55', tz: 'America/Chicago' };
    const slot = Date.parse('2026-11-04T08:55:00Z');
    const fail = (min: number, took = 0) => ({ at: new Date(slot + min * 60_000).toISOString(), ok: false, ms: took * 60_000 });
    const st = (runs: Array<{ at: string; ok: boolean; ms?: number }>) => ({ lastStart: runs[0]?.at ?? new Date(slot + 60_000).toISOString(), runs });
    expect(isDue(s, st([fail(1)]), slot + 30 * 60_000)).toBe(false);
    expect(isDue(s, st([fail(1)]), slot + 62 * 60_000)).toBe(true);
    // From its end: a try that took 50 minutes is due an hour after that, not an hour after it began.
    expect(isDue(s, st([fail(1, 50)]), slot + 62 * 60_000)).toBe(false);
    expect(isDue(s, st([fail(1, 50)]), slot + 112 * 60_000)).toBe(true);
    expect(isDue(s, st([fail(62), fail(1)]), slot + 123 * 60_000)).toBe(true);
    expect(isDue(s, st([fail(123), fail(62), fail(1)]), slot + 300 * 60_000)).toBe(false);
    expect(isDue(s, st([{ at: new Date(slot + 60_000).toISOString(), ok: true }]), slot + 300 * 60_000)).toBe(false);
    // A run started tonight with only yesterday's failures recorded (it was cut off): not a retry.
    expect(isDue(s, { lastStart: new Date(slot + 60_000).toISOString(), runs: [fail(-60)] }, slot + 300 * 60_000)).toBe(false);
  });

  it('a night\'s tries keep one bundle, its newest; the alert command hears one failure a night', async () => {
    // keep 1: the newest night (the 5th), and the month's first night (the 4th), each by its newest try.
    expect([...keptStamps(['20261104-0255', '20261104-0355', '20261104-0455', '20261105-0255'], 1)].sort()).toEqual(['20261104-0455', '20261105-0255']);
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`, { at: '02:55', tz: 'UTC' });
    const night = Date.parse('2026-11-04T02:56:00Z');
    await runBackup({ home: h.home, env, now: () => new Date(night), deps: fakes({ drills: [false, false, false, false] }) });
    await runBackup({ home: h.home, env, now: () => new Date(night + 70 * 60_000), deps: fakes({ drills: [false, false] }) });
    expect(alerts.filter((a) => /failed/.test(a.summary))).toHaveLength(1);
    await runBackup({ home: h.home, env, now: () => new Date(night + 140 * 60_000), deps: fakes() });
    await runBackup({ home: h.home, env, now: () => new Date(night + 200 * 60_000), deps: fakes() });
    expect(readdirSync(dir).filter((n) => n.endsWith('.bundle'))).toEqual(['loom-household-20261104-0616.bundle']);
  });

  it('only one of two racing for the lock gets it; a lock whose pid is gone is taken over', () => {
    const a = takeLock(h.home);
    expect(a).not.toBeNull();
    expect(takeLock(h.home)).toBeNull();
    a!.release();
    writeFileSync(join(h.home, 'backup', 'run.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
    const b = takeLock(h.home);
    expect(b).not.toBeNull();
    b!.release();
  });

  it('the tick runs a due backup once, says a miss once, again after 6 hours, and an OK when it\'s over', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    const set = pinSetAt(NOON_CHICAGO);
    // Two days on with no run: a miss is said (the tick also runs the one that's due, and here it fails).
    const deps = fakes({ drills: [false, false, false, false] });
    const t1 = set + 2 * 86_400_000;
    expect(await tickBackup({ home: h.home, env, nowMs: t1, deps })).toBe('ran');
    expect(alerts.map((a) => a.summary)).toEqual(["The nightly backup hasn't run yet", expect.stringMatching(/^The nightly backup failed: the drill/)]);
    // The failed run is now what's wrong (not the miss), so the tick says nothing more and runs nothing more today.
    expect(await tickBackup({ home: h.home, env, nowMs: t1 + 10 * 60_000, deps })).toBe('idle');
    expect(alerts).toHaveLength(2);
    // A good run: OK again, cleared.
    expect(await tickBackup({ home: h.home, env, nowMs: t1 + 86_400_000, deps: fakes() })).toBe('ran');
    expect(alerts[2]).toMatchObject({ summary: 'The nightly backup is OK again', facts: expect.objectContaining({ cleared: 1 }) });
    expect(backupProblem(h, t1 + 86_400_000 + 60_000)).toBeNull();
  });

  it('a miss lasting is said again every 6 hours, not every tick', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`, { at: '02:55' });
    // A run that's started counts as the day's: lastStart is now, so the tick only says the miss.
    const set = pinSetAt(NOON_CHICAGO);
    const t = set + 30 * 3600_000;
    writeFileSync(join(h.home, 'backup', 'state.json'), JSON.stringify({ ...readState(h.home), lastStart: new Date(t).toISOString() }));
    const deps = fakes();
    await tickBackup({ home: h.home, env, nowMs: t, deps });
    await tickBackup({ home: h.home, env, nowMs: t + 10 * 60_000, deps });
    expect(alerts.map((a) => a.summary)).toEqual(["The nightly backup hasn't run yet"]);
    // 6 hours on (midnight in Chicago, before the 02:55 slot): said again, and nothing ran.
    await tickBackup({ home: h.home, env, nowMs: t + 6 * 3600_000, deps });
    expect(alerts.map((a) => a.summary)).toEqual(["The nightly backup hasn't run yet", "The nightly backup hasn't run yet (still)"]);
  });

  it('the real alert command: a failed run reaches LOOM_ALERT_COMMAND, with source loom-backup; a planted household command never runs', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    const heard = join(work, 'heard');
    const cmd = join(work, 'alert.sh');
    // Written whole, then moved into place: a plain `>` makes the file before printf fills it, and the wait below read
    // it empty (t-1886).
    writeFileSync(cmd, `#!/bin/sh\nprintf '%s\\n' "$@" > ${heard}.part && mv ${heard}.part ${heard}\n`);
    chmodSync(cmd, 0o755);
    writeFileSync(join(h.home, 'household.json'), JSON.stringify({ ...rawHousehold(h.home), backup: { ...(rawHousehold(h.home).backup as object), alertCommand: ['/bin/touch', join(work, 'planted')] } }));
    const { alert: _a, ...noAlert } = fakes({ drills: [false, false, false, false] });
    // No LOOM_ALERT_COMMAND: nothing runs, the household's plant least of all.
    await runBackup({ home: h.home, env, deps: noAlert });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(work, 'planted'))).toBe(false);
    // The next night (a night's second failure isn't said again).
    await runBackup({ home: h.home, env: { ...env, LOOM_ALERT_COMMAND: JSON.stringify([cmd]) }, now: () => new Date(Date.now() + 86_400_000), deps: noAlert });
    for (let i = 0; i < 50 && !existsSync(heard); i++) await new Promise((r) => setTimeout(r, 100));
    const argv = readFileSync(heard, 'utf-8').split('\n');
    expect(argv.slice(0, 5)).toEqual(['loom-backup', '--severity', 'bad', '--summary', expect.stringMatching(/^The nightly backup failed: the drill/)]);
    expect(existsSync(join(work, 'planted'))).toBe(false);
  });

  it('two ticks racing: the one without the lock runs nothing', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    const exported = { n: 0 };
    const held = takeLock(h.home)!;
    expect(await tickBackup({ home: h.home, env, deps: fakes({ exported }) })).toBe('busy');
    expect(exported.n).toBe(0);
    held.release();
    const [a, b] = await Promise.all([tickBackup({ home: h.home, env, deps: fakes({ exported }) }), tickBackup({ home: h.home, env, deps: fakes({ exported }) })]);
    expect([a, b].sort()).toEqual(['busy', 'ran']);
    expect(exported.n).toBe(1);
  });

  it('a git target that\'s a local repo inside $LOOM_HOME is refused; so is a main with an empty tree', async () => {
    expect(() => settings(`git:${join(h.home, 'vault.git')}`)).toThrow(/inside loom's home/);
    expect(() => settings(`git:file://${join(h.home, 'vault.git')}`)).toThrow(/inside loom's home/);
    const remote = join(work, 'empty-main.git');
    git(['init', '-q', '--bare', remote]);
    const clone = join(work, 'c2');
    git(['clone', '-q', remote, clone]);
    git(['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--allow-empty', '-m', 'empty'], clone);
    git(['push', '-q', 'origin', 'HEAD:main'], clone);
    settings(`git:${remote}`);
    const exported = { n: 0 };
    expect((await runBackup({ home: h.home, env, deps: fakes({ exported }) })).why).toMatch(/has a main loom didn't write/);
    expect(exported.n).toBe(0);
  });

  it('RESTORE.md fits its target: a directory\'s names no bundles/ and no branch', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    expect((await runBackup({ home: h.home, env, deps: fakes() })).parts).toBe(1);
    const text = readFileSync(join(dir, 'RESTORE.md'), 'utf-8');
    expect(text).toMatch(/loom restore loom-household-<stamp>\.bundle/);
    expect(text).not.toMatch(/bundles\/|branch|part-/);
    expect(statSync(join(dir, '.loom-backup')).mode & 0o777).toBe(0o600);
  });

  it('the miss\'s alert carries minutes', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    const t = Date.parse(readState(h.home).setAt!) + 30 * 3600_000;
    writeFileSync(join(h.home, 'backup', 'state.json'), JSON.stringify({ ...readState(h.home), lastStart: new Date(t).toISOString() }));
    await tickBackup({ home: h.home, env, nowMs: t, deps: fakes() });
    expect(alerts[0].facts).toMatchObject({ minutes: 1800 });
  });

  it('a lock that changes after it was judged stale is someone\'s fresh one: left where it is, never taken', () => {
    mkdirSync(join(h.home, 'backup'), { recursive: true });
    const lock = join(h.home, 'backup', 'run.lock');
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 4321, at: new Date().toISOString() }));
    let fresh: ReturnType<typeof takeLock> = null;
    // Between this taker's judging and its takeover, another takes the stale lock over and holds a fresh one.
    const late = takeLock(h.home, Date.now(), { judged: () => { fresh = takeLock(h.home); } });
    expect(fresh).not.toBeNull();
    expect(late).toBeNull();
    const held = JSON.parse(readFileSync(lock, 'utf-8'));
    expect(held.pid).toBe(process.pid);
    fresh!.release();
    expect(existsSync(lock)).toBe(false);
  });

  it('a takeover claim held by a live taker is waited on; one whose taker died is cleared, and the lock is taken next time', () => {
    mkdirSync(join(h.home, 'backup'), { recursive: true });
    const lock = join(h.home, 'backup', 'run.lock');
    const stale = JSON.stringify({ pid: 2 ** 22 + 4321, at: new Date().toISOString() });
    writeFileSync(lock, stale);
    // A live taker (this process) is mid-takeover, however long it's been: the lock is left alone.
    writeFileSync(`${lock}.takeover`, `${process.pid} someone`);
    utimesSync(`${lock}.takeover`, new Date(0), new Date(0));
    expect(takeLock(h.home, Date.now() + 86_400_000)).toBeNull();
    expect(readFileSync(lock, 'utf-8')).toBe(stale);
    expect(existsSync(`${lock}.takeover`)).toBe(true);
    // Its taker died there: the claim is cleared, and the next try takes the lock over.
    writeFileSync(`${lock}.takeover`, `${2 ** 22 + 999} someone`);
    expect(takeLock(h.home)).toBeNull();
    expect(existsSync(`${lock}.takeover`)).toBe(false);
    const got = takeLock(h.home);
    expect(got).not.toBeNull();
    got!.release();
    expect(readdirSync(join(h.home, 'backup')).filter((n) => n.startsWith('run.lock'))).toEqual([]);
  });

  it('a stale lock taken over by two processes at once: one gets it; a run never releases its successor\'s lock', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    writeFileSync(join(h.home, 'backup', 'run.lock'), JSON.stringify({ pid: 2 ** 22 + 4321, at: new Date().toISOString() }));
    const script = join(work, 'race.mjs');
    writeFileSync(script, `import { takeLock } from ${JSON.stringify(new URL('./backup.ts', import.meta.url).pathname.replace(/\.ts$/, '.js').replace('/src/', '/dist/'))};
import { readdirSync, writeFileSync } from 'node:fs';
// All three judge the same lock stale before any takes it over: each says so, then waits for the others (5 s at most).
const met = process.argv[3];
const judged = () => { writeFileSync(met + '/' + process.pid, ''); const until = Date.now() + 5000; while (readdirSync(met).length < 3 && Date.now() < until); };
const l = takeLock(process.argv[2], Date.now(), { judged }); console.log(l ? 'got' : 'busy'); if (l) { process.stdin.on('end', () => l.release()); process.stdin.resume(); }`);
    const met = join(work, 'met'); mkdirSync(met);
    // The one that gets it holds it until all three have said (a fixed 400 ms let a slow starter find it free, t-1886).
    let said = 0;
    const all: Array<() => void> = [];
    const run1 = () => new Promise<string>((res) => {
      const c = spawn(process.execPath, [script, h.home, met], { env });
      all.push(() => c.stdin.end());
      let o = '';
      let heard = false;
      // One that dies without a word has said too, so the holder is never left waiting.
      const say = () => { if (heard) return; heard = true; if (++said === 3) for (const end of all) end(); };
      c.stdout.on('data', (d) => { o += d; say(); });
      c.on('close', () => { say(); res(o.trim()); });
    });
    const outs = await Promise.all([run1(), run1(), run1()]);
    expect(outs.sort()).toEqual(['busy', 'busy', 'got']);
    // All three were in the takeover at once, not one after another's fresh lock.
    expect(readdirSync(met)).toHaveLength(3);
    // A lock taken over as stale: the old holder's release leaves the new one's.
    const old = takeLock(h.home)!;
    writeFileSync(join(h.home, 'backup', 'run.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: 'successor' }));
    old.release();
    expect(JSON.parse(readFileSync(join(h.home, 'backup', 'run.lock'), 'utf-8')).token).toBe('successor');
  });

  it('the push\'s lease: a remote that moved after this run read it is never pushed over', async () => {
    const remote = join(work, 'remote.git');
    git(['init', '-q', '--bare', remote]);
    settings(`git:${remote}`);
    expect((await runBackup({ home: h.home, env, now: () => new Date('2026-10-02T09:00:00Z'), deps: fakes() })).ok).toBe(true);
    let theirs = '';
    const run = await runBackup({ home: h.home, env, now: () => new Date('2026-10-03T09:00:00Z'), deps: { ...fakes(), beforePush: () => {
      // Another machine pushes its night meanwhile.
      const c = join(work, 'other'); git(['clone', '-q', '-b', 'main', remote, c]);
      writeFileSync(join(c, 'bundles', 'loom-household-20261003-0300.bundle'), 'theirs');
      git(['add', '-A'], c); git(['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'theirs'], c); git(['push', '-q', 'origin', 'HEAD:main'], c);
      theirs = git(['rev-parse', 'HEAD'], c);
    } } });
    expect(run.ok).toBe(false);
    expect(run.why).toMatch(/git push failed/);

    expect(git(['--git-dir', remote, 'rev-parse', 'main'])).toBe(theirs);
  }, 30_000);

  it('a failure then a good run: an FYI in the household owner\'s Inbox that it\'s OK again', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    await runBackup({ home: h.home, env, deps: fakes({ drills: [false, false, true] }) });
    expect(backupFyi(h)).toBeNull();
    await runBackup({ home: h.home, env, now: () => new Date(Date.now() + 60_000), deps: fakes() });
    expect(backupFyi(h)).toMatchObject({ text: 'The nightly backup is OK again' });
    expect(backupFyi(h, Date.now() + 8 * 86_400_000)).toBeNull();
  });

  it('Setup: the Backup row and its form are a household owner\'s; the form sets it', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    const ids = (o: { ownerTokens?: boolean } = { ownerTokens: true }) => agentSetup(h, 'art', o).sections.map((x) => x.id);
    const row = (o: { ownerTokens?: boolean } = { ownerTokens: true }) => JSON.stringify(agentSetup(h, 'art', o).sections[0]).includes('"Backup"');
    expect(ids()).toContain('backup');
    expect(row()).toBe(true);
    expect(ids({ ownerTokens: false })).not.toContain('backup');
    // Fail closed: a caller that doesn't say it's a household owner's page gets no backup.
    expect(ids({})).not.toContain('backup');
    expect(row({ ownerTokens: false })).toBe(false);
    const r = await householdAct(h, 'backup-set', { target: `path:${dir}`, recipients: owner.recipient, at: '04:00', tz: 'UTC', keep: '5', required: 'box secrets' });
    expect(r).toMatchObject({ ok: true });
    expect(readSettings(h).settings).toMatchObject({ at: '04:00', keep: 5, required: ['box', 'secrets'] });
    expect(await householdAct(h, 'backup-set', { target: 'nowhere', recipients: owner.recipient })).toMatchObject({ ok: false, message: expect.stringMatching(/git:<url> or path:/) });
  });

  it('settings that stop working: the alert command hears it, again 6 hours on; nothing runs', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    writeFileSync(join(h.home, 'household.json'), JSON.stringify({ ...rawHousehold(h.home), backup: { target: 'nowhere', recipients: [owner.recipient] } }));
    const exported = { n: 0 };
    const t = Date.now();
    expect(await tickBackup({ home: h.home, env, nowMs: t, deps: fakes({ exported }) })).toBe('idle');
    expect(await tickBackup({ home: h.home, env, nowMs: t + 600_000, deps: fakes({ exported }) })).toBe('idle');
    await tickBackup({ home: h.home, env, nowMs: t + 6 * 3600_000, deps: fakes({ exported }) });
    expect(alerts.map((a) => a.summary)).toEqual(["The nightly backup can't run: its settings don't work", "The nightly backup can't run: its settings don't work (still)"]);
    expect(exported.n).toBe(0);
  });

  it('the daemon\'s tick never throws, whatever the home', () => {
    const file = join(work, 'a-file'); writeFileSync(file, 'x');
    const ro = { ...h, home: join(file, 'home') };
    expect(() => spawnBackupTick(ro as Household, env, { wanted: () => true })).not.toThrow();
  });

  // ─── What the owner sees ──────────────────────────────────────────────────

  it('the Inbox has a backup alert after a failed run and after 26 hours with none; none after a good run; Setup shows it', async () => {
    expect(backupAsks(h)).toEqual([]);
    expect(agentSetup(h, 'art', { ownerTokens: true }).sections[0].blocks[0]).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ label: 'Backup', text: 'not set up' })]) });
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    expect(backupAsks(h)).toEqual([]);
    expect(backupAsks(h, Date.now() + 27 * 3600_000)).toMatchObject([{ kind: 'alert', text: "The nightly backup hasn't run yet", sourceLabel: 'Backup' }]);
    await runBackup({ home: h.home, env, deps: fakes({ drills: [false, false] }) });
    expect(backupAsks(h)).toMatchObject([{ kind: 'alert', text: 'The nightly backup failed', meta: expect.stringMatching(/drill/) }]);
    // Failed and 26 hours with none: one alert, the failure.
    expect(backupAsks(h, Date.now() + 27 * 3600_000)).toMatchObject([{ text: 'The nightly backup failed' }]);
    expect(backupAsks(h)[0].agent).toBeUndefined();
    expect(backupRow(h)).toMatchObject({ tone: 'bad', text: 'failed' });
    const good = await runBackup({ home: h.home, env, now: () => new Date(Date.now() + 60_000), deps: fakes({ bytes: 3 * 1048576 }) });
    expect(good.ok).toBe(true);
    expect(backupAsks(h)).toEqual([]);
    expect(backupRow(h, Date.now(), () => 'just now')).toMatchObject({ tone: 'ok', text: 'just now', meta: `drill passed · 3 MB · to ${dir}` });
    const row = (agentSetup(h, 'art', { ownerTokens: true }).sections[0].blocks[0] as { items: Array<{ label: string; tone: string }> }).items.find((i) => i.label === 'Backup');
    expect(row?.tone).toBe('ok');
    expect(backupAsks(h, Date.now() + 27 * 3600_000)).toMatchObject([{ text: expect.stringMatching(/^No backup since /) }]);
  });

  it('the alert command is LOOM_ALERT_COMMAND\'s, never anything in household.json', () => {
    const hh = rawHousehold(h.home);
    writeFileSync(join(h.home, 'household.json'), JSON.stringify({ ...hh, backup: { alertCommand: ['/bin/touch', join(work, 'planted')] } }));
    const a: CoreAlert = { source: 'loom-backup', severity: 'bad', summary: 'The nightly backup failed', facts: { at: 'x', drill: 'failed', 'Bad Key': 'no' } };
    expect(alertCommandArgv(env, a)).toBeNull();
    expect(alertCommandArgv({ ...env, LOOM_ALERT_COMMAND: '["/usr/bin/alert"]' }, a))
      .toEqual(['/usr/bin/alert', 'loom-backup', '--severity', 'bad', '--summary', 'The nightly backup failed', '--fact', 'at=x', '--fact', 'drill=failed']);
    expect(alertCommandArgv({ ...env, LOOM_ALERT_COMMAND: 'touch x' }, a)).toBeNull();
    expect(alertCommandArgv({ ...env, LOOM_ALERT_COMMAND: '["/usr/bin/alert"]' }, { ...a, source: 'Bad Source' })).toBeNull();
  });

  it('a drill key is the machine\'s own: made once, the same after', () => {
    const a = ensureDrillKey(h.home, env);
    const b = ensureDrillKey(h.home, env);
    expect(a).toEqual(b);
    expect(a.recipient).toMatch(/^age1/);
  });
  it('the CLI: set, status and run, end to end with the real export (a path target)', async () => {
    const dir = join(work, 'stick'); mkdirSync(dir);
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (x: string) => { out.push(x); }, stderr: (x: string) => { err.push(x); }, stdin: Readable.from([]), stdinIsTTY: false, env: { ...env, LOOM_HOME: h.home } };
    expect(await runCli(['backup', 'set', '--target', `path:${dir}`, '--recipient', owner.recipient, '--at', '04:10', '--tz', 'UTC'], io)).toBe(0);
    expect(out.join('')).toMatch(/each day at 04:10 \(UTC\)/);
    expect(await runCli(['backup', 'set', '--target', 'nowhere', '--recipient', owner.recipient], io)).toBe(1);
    expect(err.join('')).toMatch(/git:<url> or path:/);
    expect(await runCli(['backup', 'run'], io)).toBe(0);
    expect(out.join('')).toMatch(/Backed up: loom-household-\d{8}-\d{4}\.bundle .*drill passed/);
    expect(await runCli(['backup', 'status', '--json'], io)).toBe(0);
    const st = JSON.parse(out[out.length - 1]);
    expect(st).toMatchObject({ settings: { target: `path:${dir}`, at: '04:10' }, now: null, lastGood: { ok: true } });
  });
  it('the daemon starts a tick only for a household with a backup set, as a detached child', () => {
    const calls: Array<{ cmd: string; args: string[]; o: { detached?: boolean; env?: NodeJS.ProcessEnv } }> = [];
    const spawnImpl = ((cmd: string, args: string[], o: object) => { calls.push({ cmd, args, o: o as never }); return { on() {}, unref() {} }; }) as never;
    expect(spawnBackupTick(h, env, { spawnImpl, entry: '/x/dist/index.js' })).toBe(false);
    const dir = join(work, 'stick'); mkdirSync(dir);
    settings(`path:${dir}`);
    // Set, but nothing to do now (not due, no miss): no child.
    writeFileSync(join(h.home, 'backup', 'state.json'), JSON.stringify({ ...readState(h.home), lastStart: new Date().toISOString() }));
    expect(spawnBackupTick(h, env, { spawnImpl, entry: '/x/dist/index.js' })).toBe(false);
    expect(spawnBackupTick(h, env, { spawnImpl, entry: '/x/dist/index.js', wanted: () => true })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['/x/dist/index.js', 'backup', 'tick']);
    expect(calls[0].o.detached).toBe(true);
    expect(calls[0].o.env?.LOOM_HOME).toBe(h.home);
    // The real entry: a built loom that runs `backup tick`.
    expect(existsSync(ENTRY)).toBe(true);
    const r = spawnSync(process.execPath, [ENTRY, 'backup', 'tick'], { env: { ...env, LOOM_HOME: h.home }, encoding: 'utf-8' });
    expect(r.stdout.trim()).toBe('idle');
  });
});

