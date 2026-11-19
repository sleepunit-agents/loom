import { expect, it } from 'vitest';
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
});

it('says signed in for a Claude sign-in that holds only a working token', async () => {
  const only = JSON.stringify({ claudeAiOauth: { accessToken: 'a' } });
  expect(await readLogin('claude', '/d', { read: files({ '/d/.credentials.json': only }), now })).toEqual({ state: 'signed-in' });
});

it('does not call a file it cannot read, or one caught half written, signed out, and says nothing of what it found', async () => {
  const denied = Object.assign(new Error('EACCES: /d/.credentials.json secret-path'), { code: 'EACCES' });
  for (const found of [denied, '', '{"claudeAiOauth":{"refreshToken":"secret-r"', 'not json secret-text'])
    for (const [harness, name] of [['claude', '.credentials.json'], ['codex', 'auth.json']]) {
      const error: unknown = await readLogin(harness, '/d', { read: files({ ['/d/' + name]: found }), now }).then(() => undefined, caught => caught);
      expect((error as Error).message).toBe('Sign-in file unreadable');
      expect(String((error as Error).stack)).not.toContain('secret');
    }
  expect(watchesLogin('claude') && watchesLogin('codex')).toBe(true);
  expect(watchesLogin('gemini') || watchesLogin('constructor')).toBe(false);
  expect(() => readLogin('gemini', '/g')).toThrow('not watched');
});
