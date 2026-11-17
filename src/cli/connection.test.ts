/** One token file, three clients: each accepts or refuses it as the others do. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAccessClient } from './access-client.js';
import { runSharedTaskClient } from './shared-task-client.js';
import { sharedStdioConfig } from '../shared-mcp-stdio.js';
import type { IOStreams } from './io.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'loom-connection-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

/** Which clients got as far as presenting the token, and what each presented. */
async function presented(contents: string | Buffer): Promise<(string | undefined)[]> {
  const file = join(directory, 'token'); writeFileSync(file, contents);
  const env = { LOOM_URL: 'http://127.0.0.1:1', LOOM_TOKEN_FILE: file };
  const io: IOStreams = { stdout() {}, stderr() {}, stdin: process.stdin, stdinIsTTY: true, env };
  const sent: (string | undefined)[] = [];
  const runtime = (index: number) => ({ retry: async () => {}, request: (async (_url: unknown, init?: RequestInit) => {
    sent[index] = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
    return Response.json({}, { status: 400 });
  }) as typeof fetch });
  sent[0] = undefined; await runAccessClient('token', ['list'], io, runtime(0));
  sent[1] = undefined; await runSharedTaskClient(['list'], io, runtime(1));
  try { sent[2] = sharedStdioConfig(['mcp'], env).token; } catch { sent[2] = undefined; }
  return sent;
}

it('reads one token file the same way in every client', async () => {
  // A token of any length the program might issue, with the newline an editor leaves.
  expect(await presented('loom_fictional-token\n')).toEqual(Array(3).fill('loom_fictional-token'));
  expect(await presented('x'.repeat(4096))).toEqual(Array(3).fill('x'.repeat(4096)));
  // Not a token for any of them: empty, a space inside, a control character, too long, a file too large to be one.
  for (const bad of ['', '  \n', 'two words', 'bell\u0007', 'x'.repeat(4097), Buffer.alloc(8193, 0x20)])
    expect(await presented(bad), JSON.stringify(String(bad).slice(0, 12))).toEqual([undefined, undefined, undefined]);
});
