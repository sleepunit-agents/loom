import { expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
vi.mock('better-sqlite3', () => { throw Error('Remote client must not import SQLite'); });
vi.mock('../core/index.js', () => { throw Error('Remote client must not import the daemon'); });
vi.mock('node:child_process', () => { throw Error('Remote client must not import subprocesses'); });
vi.mock('node:fs', () => { throw Error('Remote client must not open local stores'); });
const { read } = vi.hoisted(() => ({ read: vi.fn(async (path: string) => {
  if (path !== '/fixture/client-token') throw Error('Only the explicit token file may be read');
  return 'fixture-token';
}) }));
vi.mock('node:fs/promises', () => ({ readFile: read }));
import { runSecretsClient } from './secrets-client.js';
it('loads without database/daemon/subprocess dependencies and reads only its explicit token file', async () => {
  let stdout = '', stderr = '';
  const code = await runSecretsClient(['list', '--json'], {
    stdout: text => stdout += text, stderr: text => stderr += text, stdin: Readable.from([]), stdinIsTTY: false,
    env: { LOOM_URL: 'https://fixture.invalid', LOOM_TOKEN_FILE: '/fixture/client-token', LOOM_HOME: '/forbidden', LOOM_SECRETS_DIR: '/forbidden-legacy' },
  }, { request: async () => new Response(JSON.stringify({ ok: true, value: { stdout: '["API"]\n', stderr: '', code: 0 } })), retry: async () => {} });
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '["API"]\n', stderr: '' });
  expect(read.mock.calls).toEqual([['/fixture/client-token', 'utf8']]);
});
