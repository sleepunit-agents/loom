import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LOGIN_REASONS, readLogin, watchesLogin } from './account-login-check.js';

const files = (found: Record<string, string | Error>) => async (path: string) => {
  const value = found[path];
  if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  if (value instanceof Error) throw value;
  return value;
};
const now = () => Date.parse('2026-11-19T14:00:00.000Z');

it('reads when a Claude sign-in ends, and returns nothing of the tokens', async () => {
  const ends = Date.parse('2026-12-14T12:30:00.000Z');
  const read = files({ '/logins/claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'secret-a', refreshToken: 'secret-r', expiresAt: 1, refreshTokenExpiresAt: ends } }) });
  const login = await readLogin('claude', '/logins/claude', { read, now });
  expect(login).toEqual({ state: 'signed-in', expiresAt: '2026-12-14T12:30:00.000Z' });
  expect(JSON.stringify(login)).not.toContain('secret');
});

it('says signed out, with a reason from the fixed list, for a missing file, an empty sign-in and a sign-in that has ended', async () => {
  expect(await readLogin('claude', '/none', { read: files({}), now })).toEqual({ state: 'signed-out', why: 'no-file' });
  expect(await readLogin('claude', '/d', { read: files({ '/d/.credentials.json': '{"mcpOAuth":{}}' }), now })).toEqual({ state: 'signed-out', why: 'no-sign-in' });
  const ended = JSON.stringify({ claudeAiOauth: { refreshToken: 'r', refreshTokenExpiresAt: now() - 1 } });
  expect(await readLogin('claude', '/d', { read: files({ '/d/.credentials.json': ended }), now })).toEqual({ state: 'signed-out', why: 'ended' });
  for (const why of ['no-file', 'no-sign-in', 'ended']) expect(LOGIN_REASONS).toContain(why);
});

it('says signed in without an end where the file gives none', async () => {
  const noEnd = JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } });
  expect(await readLogin('claude', '/d', { read: files({ '/d/.credentials.json': noEnd }), now })).toEqual({ state: 'signed-in' });
  expect(await readLogin('codex', '/c', { read: files({ '/c/auth.json': JSON.stringify({ tokens: { refresh_token: 'r' }, OPENAI_API_KEY: null }) }), now })).toEqual({ state: 'signed-in' });
  expect(await readLogin('codex', '/c', { read: files({ '/c/auth.json': JSON.stringify({ tokens: {}, OPENAI_API_KEY: null }) }), now })).toEqual({ state: 'signed-out', why: 'no-sign-in' });
  expect(await readLogin('codex', '/c', { read: files({ '/c/auth.json': JSON.stringify({ tokens: { access_token: 'a' } }) }), now })).toEqual({ state: 'signed-in' });
  // An end loom could not keep (another unit, a sentinel) is no known end, never a report loom would refuse whole.
  for (const ends of [1e15, 253_402_300_800_000, -1, 0, 1_797_557_332, '2026-12-14', null])
    expect(await readLogin('claude', '/d', { read: files({ '/d/.credentials.json': JSON.stringify({ claudeAiOauth: { refreshToken: 'r', refreshTokenExpiresAt: ends } }) }), now })).toEqual({ state: 'signed-in' });
  expect(await readLogin('claude', '/d', { read: files({ '/d/.credentials.json': JSON.stringify({ claudeAiOauth: { refreshToken: 'r', refreshTokenExpiresAt: 253_402_300_799_999 } }) }), now })).toEqual({ state: 'signed-in', expiresAt: '9999-12-31T23:59:59.999Z' });
});

it('says signed in for a Claude sign-in that holds only a working token', async () => {
  const only = JSON.stringify({ claudeAiOauth: { accessToken: 'a' } });
  expect(await readLogin('claude', '/d', { read: files({ '/d/.credentials.json': only }), now })).toEqual({ state: 'signed-in' });
});

it('does not call a file it cannot read, or one caught half written, signed out, and says nothing of what it found', async () => {
  const denied = Object.assign(new Error('EACCES: /d/.credentials.json secret-path'), { code: 'EACCES' });
  for (const found of [denied, '', '{"claudeAiOauth":{"refreshToken":"secret-r"', 'not json secret-text', 'null', '[]', '"secret-word"', '0'])
    for (const [harness, name] of [['claude', '.credentials.json'], ['codex', 'auth.json']]) {
      const error: unknown = await readLogin(harness, '/d', { read: files({ ['/d/' + name]: found }), now }).then(() => undefined, caught => caught);
      expect((error as Error).message).toBe('Sign-in file unreadable');
      expect(String((error as Error).stack)).not.toContain('secret');
    }
  expect(watchesLogin('claude') && watchesLogin('codex')).toBe(true);
  expect(watchesLogin('gemini') || watchesLogin('constructor')).toBe(false);
  await expect(readLogin('gemini', '/g')).rejects.toThrow('not watched');
});

// The directory houses mount is writable by the bodies in them: what stands under the name the worker opens
// may be anything a body could make. These read real files, with the reader the worker uses.
const made: string[] = [];
afterEach(() => { for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const good = JSON.stringify({ claudeAiOauth: { refreshToken: 'r', refreshTokenExpiresAt: Date.parse('2026-12-14T12:30:00.000Z') } });
function directory() { const made_ = mkdtempSync(join(tmpdir(), 'loom-login-check-')); made.push(made_); return made_; }

it('reads an ordinary sign-in file from disk, and a missing one as no file', async () => {
  const d = directory();
  expect(await readLogin('claude', d, { now })).toEqual({ state: 'signed-out', why: 'no-file' });
  writeFileSync(join(d, '.credentials.json'), good);
  expect(await readLogin('claude', d, { now })).toEqual({ state: 'signed-in', expiresAt: '2026-12-14T12:30:00.000Z' });
});

it('does not follow a link, wait on a pipe, read a directory or take a file too large for a sign-in: each is not knowing', async () => {
  const elsewhere = directory(); writeFileSync(join(elsewhere, 'other.json'), good);
  const plant: Record<string, (path: string) => void> = {
    'a link to a good file elsewhere': path => symlinkSync(join(elsewhere, 'other.json'), path),
    'a link to a device with no end': path => symlinkSync('/dev/zero', path),
    'a link to nothing': path => symlinkSync(join(elsewhere, 'absent'), path),
    'a pipe nobody writes to': path => { execFileSync('mkfifo', [path]); },
    'a directory': path => mkdirSync(path),
    'a file larger than a sign-in': path => writeFileSync(path, '{"claudeAiOauth":{"refreshToken":"' + 'r'.repeat(1024 * 1024) + '"}}'),
  };
  for (const [what, make] of Object.entries(plant)) {
    const d = directory(); make(join(d, '.credentials.json'));
    const outcome = await Promise.race([readLogin('claude', d, { now }).then(read => read, caught => (caught as Error).message),
      new Promise(resolve => setTimeout(() => resolve('never settled'), 2_000))]);
    expect([what, outcome]).toEqual([what, 'Sign-in file unreadable']);
  }
}, 20_000);
