import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, 'check-signoff.sh');
const SIGNED = 'Signed-off-by: Ada Lovelace <ada@example.com>';

let dir: string;

function git(args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com',
      ...env,
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(message: string): string {
  git(['commit', '-q', '--allow-empty', '--no-verify', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

const GITHUB = { GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' };

// feature (signed) + main (signed) diverge, then main is merged into feature
// unsigned, committed with `env`. Returns the fork point.
function mergeMainIntoFeature(env: Record<string, string>): string {
  const base = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', '-b', 'feature']);
  commit(`feature\n\n${SIGNED}`);
  git(['checkout', '-q', 'main']);
  commit(`main moved\n\n${SIGNED}`);
  git(['checkout', '-q', 'feature']);
  git(['merge', '-q', '--no-verify', '-m', "Merge branch 'main' into feature", 'main'], env);
  return base;
}

function check(...args: string[]): number | null {
  return spawnSync('bash', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' }).status;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'check-signoff-'));
  git(['init', '-q', '-b', 'main']);
  commit('base');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('check-signoff --range', () => {
  it('passes when every commit is signed off', () => {
    const base = git(['rev-parse', 'HEAD']);
    commit(`one\n\n${SIGNED}`);
    commit(`two\n\nbody\n\n${SIGNED}`);
    expect(check('--range', base, 'HEAD')).toBe(0);
  });

  it('fails when a commit below the tip is unsigned', () => {
    const base = git(['rev-parse', 'HEAD']);
    commit('one');
    commit(`two\n\n${SIGNED}`);
    expect(check('--range', base, 'HEAD')).toBe(1);
  });

  it('fails an unsigned non-merge commit whose committer is GitHub (web editor)', () => {
    const base = git(['rev-parse', 'HEAD']);
    git(['commit', '-q', '--allow-empty', '--no-verify', '-m', 'edit in browser'], GITHUB);
    commit(`two\n\n${SIGNED}`);
    expect(check('--range', base, 'HEAD')).toBe(1);
  });

  it('fails a sign-off without a name and email, or in the body instead of the trailers', () => {
    const base = git(['rev-parse', 'HEAD']);
    commit('one\n\nSigned-off-by: x');
    expect(check('--range', base, 'HEAD')).toBe(1);
    const base2 = git(['rev-parse', 'HEAD']);
    commit(`two\n\n${SIGNED}\n\nmore prose after it`);
    expect(check('--range', base2, 'HEAD')).toBe(1);
  });

  it('fails, never passes, when a SHA is not in the clone', () => {
    expect(check('--range', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'HEAD')).not.toBe(0);
  });

  it('fails an unsigned merge commit made by a person', () => {
    const base = mergeMainIntoFeature({});
    commit(`after the merge\n\n${SIGNED}`);
    expect(check('--range', base, 'HEAD')).toBe(1);
  });

  it("skips the unsigned merge GitHub's Update branch button makes", () => {
    const base = mergeMainIntoFeature(GITHUB);
    commit(`after the merge\n\n${SIGNED}`);
    expect(check('--range', base, 'HEAD')).toBe(0);
  });
});

describe('check-signoff --message', () => {
  it('accepts a signed message and rejects an unsigned one', () => {
    const signed = join(dir, 'signed.txt');
    const unsigned = join(dir, 'unsigned.txt');
    writeFileSync(signed, `subject\n\nbody\n\n${SIGNED}\n`);
    writeFileSync(unsigned, 'subject\n\nbody\n');
    expect(check('--message', signed)).toBe(0);
    expect(check('--message', unsigned)).toBe(1);
  });

  it('exits 2 on usage errors', () => {
    expect(check()).toBe(2);
    expect(check('--range', 'HEAD')).toBe(2);
  });
});
