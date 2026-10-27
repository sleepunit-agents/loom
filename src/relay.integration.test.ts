/**
 * Agent to agent over MCP (t-1597): a household session's `relay` tool runs
 * the clock piece's `relay` as that session's own agent, through the same
 * piece API a house's `wake relay` uses. Pins that
 *  - the clock sees the caller as the token's agent, never the owner;
 *  - the tool's arguments arrive as the clock's argv;
 *  - the clock's refusal comes back as a tool error, its words intact.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { createToken, loadHousehold, type Household } from './household.js';

describe('the relay tool', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let seen: string;
  const tok: Record<string, string> = {};
  const savedPath = process.env.PATH;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-relay-'));
    for (const agent of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', agent), { recursive: true });
      writeFileSync(join(home, 'agents', agent, 'IDENTITY.md'), `# ${agent}\n`);
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art' }));
    h = loadHousehold(home)!;
    const bin = join(home, 'bin');
    mkdirSync(bin);
    seen = join(home, 'seen.jsonl');
    // A clock that writes down what core asked, and refuses one recipient.
    writeFileSync(join(bin, 'loom-clock'), `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const r = JSON.parse(s);
  require('node:fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify(r) + '\\n');
  const argv = r.body.argv;
  if (argv[2] === 'fez') return console.log(JSON.stringify({ body: { exit: 1, stdout: '', stderr: "wake: the household doesn't pair mark with fez\\n" } }));
  console.log(JSON.stringify({ body: { exit: 0, stdout: 'r-12345678: ' + argv[2] + ' wakes within a minute\\n', stderr: '' } }));
});
`);
    chmodSync(join(bin, 'loom-clock'), 0o755);
    process.env.PATH = [bin, savedPath].join(delimiter);
    tok.mark = createToken(h, { role: { kind: 'agent', agent: 'mark' }, label: 'mark' }).token;
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
  });
  afterAll(async () => {
    process.env.PATH = savedPath;
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'relay-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    return client;
  }

  it('runs the clock\'s relay as the session\'s own agent', async () => {
    const client = await connect(tok.mark);
    try {
      const r = await client.callTool({ name: 'relay', arguments: { to: 'art', say: 'hello', reply_to: 'r-aaaaaaaa' } });
      expect(r.isError).toBeFalsy();
      expect((r.content as Array<{ text: string }>)[0].text).toMatch(/art wakes within a minute/);
      const req = JSON.parse(readFileSync(seen, 'utf-8').trim().split('\n').pop()!);
      expect(req.caller).toEqual({ kind: 'agent', agent: 'mark' });
      expect(req.path).toBe('run');
      expect(req.body.argv).toEqual(['relay', '--to', 'art', '--say', 'hello', '--reply-to', 'r-aaaaaaaa']);

      const no = await client.callTool({ name: 'relay', arguments: { to: 'fez', say: 'hi' } });
      expect(no.isError).toBe(true);
      expect((no.content as Array<{ text: string }>)[0].text).toMatch(/doesn't pair mark with fez/);
    } finally {
      await client.close();
    }
  });
});
