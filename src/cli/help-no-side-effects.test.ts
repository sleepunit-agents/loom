/**
 * `--help` is help, and an unknown flag is refused, before any verb does anything (t-1950).
 *
 * `loom token link --help` used to mint a live one-time sign-in link and print it: the verb read its flags by
 * looking for the ones it knew, so --help was simply ignored. Every verb that creates, changes or deletes
 * something now parses all of its flags first (src/cli/args.ts, parseVerb). Each case here runs through the
 * whole CLI against a throwaway household and checks the household's files are byte-for-byte what they were.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { createToken, loadHousehold, loadTokens } from '../household.js';
import { sessionStore, signinLink } from '../ui/sessions.js';
import { ensureStackVersion } from '../config.js';

let home: string;
let userHome: string;
let savedHome: string | undefined;
let env: Record<string, string>;

/** Every file under dir: its path and a hash of its bytes (a symlink: its target). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[relative(dir, p)] = `-> ${readlinkSync(p)}`;
      else if (st.isDirectory()) { out[relative(dir, p) + '/'] = 'dir'; walk(p); }
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const both = () => ({ ...snapshot(home), ...Object.fromEntries(Object.entries(snapshot(userHome)).map(([k, v]) => [`~/${k}`, v])) });

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'loom-help-'));
  userHome = mkdtempSync(join(tmpdir(), 'loom-help-user-'));
  savedHome = process.env.HOME;
  process.env.HOME = userHome;
  for (const agent of ['art', 'mark']) {
    mkdirSync(join(home, 'agents', agent), { recursive: true });
    writeFileSync(join(home, 'agents', agent, 'IDENTITY.md'), `# ${agent}\n\nI am ${agent}.\n`);
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan' }));
  const h = loadHousehold(home)!;
  createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art' });
  // A sign-in link already on file, so minting another (or revoking) would show.
  signinLink(h, 600);
  // Every verb that opens an agent's stack stamps its version on a fresh one (config.ts,
  // assertStackVersionCompatible), read-only verbs too. Stamp it now, so a test sees what the verb did.
  for (const agent of ['art', 'mark']) ensureStackVersion(join(home, 'agents', agent));
  env = { LOOM_HOME: home, HOME: userHome, LOOM_CONTEXT_DIR: join(home, 'agents', 'art') };
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(userHome, { recursive: true, force: true });
});

const SECRETISH = /\/login\/|[0-9a-f]{40,}/;

describe('loom token, loom sessions: --help creates nothing', () => {
  it('token link --help prints usage, creates no link and prints no URL', async () => {
    const before = both();
    const tokensBefore = loadTokens(home).length;
    const linksBefore = JSON.stringify(sessionStore(home).list());
    for (const help of ['--help', '-h']) {
      const r = await runCliCaptured(['token', 'link', help], { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage: loom token');
      expect(r.stdout + r.stderr).not.toMatch(SECRETISH);
    }
    // Help after a real flag, too: it's still help, not a ten-minute link.
    const r = await runCliCaptured(['token', 'link', '--minutes', '5', '--help'], { env });
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(SECRETISH);
    expect(loadTokens(home).length).toBe(tokensBefore);
    expect(JSON.stringify(sessionStore(home).list())).toBe(linksBefore);
    expect(both()).toEqual(before);
  });

  it('token create --help prints usage and mints no token', async () => {
    const before = both();
    for (const argv of [['token', 'create', '--help'], ['token', 'create', '--owner', '--label', 'x', '--help'], ['token', 'create', '-h']]) {
      const r = await runCliCaptured(argv, { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage: loom token');
      expect(r.stdout + r.stderr).not.toMatch(SECRETISH);
    }
    expect(both()).toEqual(before);
  });

  it('sessions revoke --help prints usage and signs nobody out', async () => {
    const before = both();
    const ref = sessionStore(home).list()[0]?.ref;
    for (const argv of [['sessions', 'revoke', '--help'], ['sessions', 'revoke', '-h'], ...(ref ? [['sessions', 'revoke', ref, '--help']] : [])]) {
      const r = await runCliCaptured(argv, { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage: loom sessions');
    }
    expect(both()).toEqual(before);
  });

  it('an unknown flag is refused with 2 and nothing is minted', async () => {
    const before = both();
    for (const argv of [
      ['token', 'link', '--minuets', '5'],
      ['token', 'link', '--url-page', 'http://x'],
      ['token', 'create', '--owner', '--label', 'x', '--bogus'],
      ['token', 'revoke', 'art', '--bogus'],
      ['token', 'list', '--bogus'],
      ['sessions', 'revoke', 'abc', '--bogus'],
      ['token', 'link', 'stray'],
    ]) {
      const r = await runCliCaptured(argv, { env });
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stdout + r.stderr).not.toMatch(SECRETISH);
    }
    expect(both()).toEqual(before);
  });
});

/**
 * Every verb that creates, changes or deletes something. A verb added later belongs here too.
 */
const MUTATING: string[][] = [
  ['token', 'create'], ['token', 'revoke'], ['token', 'link'],
  ['sessions', 'revoke'],
  ['household', 'init'], ['household', 'add'], ['household', 'sprite'], ['household', 'commons'],
  ['household', 'icons', 'install'], ['household', 'icons', 'use'], ['household', 'icons', 'set'],
  ['backup', 'set'], ['backup', 'off'], ['backup', 'run'],
  ['export'], ['restore'],
  ['store', 'p', 'put', 'c', 'k'], ['store', 'p', 'del', 'c', 'k'], ['store', 'p', 'revert', 'c', 'k', '1'],
  ['pieces', 'install', 'x'], ['pieces', 'update', 'x'], ['pieces', 'rollback', 'x'], ['pieces', 'remove', 'x'], ['pieces', 'set', 'x', 'A=b'],
  ['remember', 'a title'], ['update', 'ref'], ['forget', 'ref'],
  ['note', 'write', 'a/b'], ['note', 'delete', 'a/b'], ['note', 'sweep'],
  ['knowledge', 'write', '--title', 't'], ['knowledge', 'maintain'],
  ['memory', 'prune'], ['memory', 'archive', 'r'], ['memory', 'restore', 'r'], ['memory', 'propose'], ['memory', 'ratify', 'r'],
  ['memory', 'reject', 'r'], ['memory', 'recompute-salience'],
  ['person', 'ensure'], ['person', 'merge', 'a', 'b'],
  ['update-identity'], ['bootstrap'], ['inject'], ['harness', 'init'], ['install'], ['migrate'],
];

describe('every verb that changes something: --help and unknown flags come first', () => {
  for (const argv of MUTATING) {
    it(`loom ${argv.join(' ')} --help changes nothing`, async () => {
      const before = both();
      const r = await runCliCaptured([...argv, '--help'], { env, stdin: '' });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/Usage/i);
      expect(both()).toEqual(before);
    });
    it(`loom ${argv.join(' ')} --no-such-flag is refused and changes nothing`, async () => {
      const before = both();
      const r = await runCliCaptured([...argv, '--no-such-flag'], { env, stdin: '' });
      expect(r.code).toBe(2);
      expect(both()).toEqual(before);
    });
  }
});
