/**
 * Offered MCP tools (src/offered-tools.ts; agent-runtime.md "Seams", 2, `mcp_tools`, and test 6's
 * last case): a tool a piece offers is in an agent's MCP session only when an installed managed
 * piece offers it. The runtime's `relay` is one: core has no relay of its own any more. Pins that
 *  - with no piece offering it, a session has no `relay` tool;
 *  - once offered, a new session has it, with the piece's description and schema;
 *  - a call runs the piece's argv plus `--agent <the session's agent>`, the arguments on stdin,
 *    with that agent's store grant, and its `{text, isError?}` answer comes back as the tool's;
 *  - a refusal (exit 1 with an answer) is a tool error in the piece's words;
 *  - the grants authority is asked first (path tools/<name>), and a no means the piece never runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { createToken, loadHousehold, type Household } from './household.js';
import { readGrant } from './stores.js';
import { clearPieceCache } from './ui/pieces.js';

describe('offered MCP tools', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let seen: string;
  let asked: string;
  const tok: Record<string, string> = {};
  const saved = { home: process.env.LOOM_HOME };

  const relay = {
    description: 'Ask another agent in this household something.',
    input_schema: { type: 'object', properties: { to: { type: 'string', description: 'The other agent' }, say: { type: 'string' } }, required: ['to', 'say'] },
    argv: ['loom-runtime', 'relay', 'tool'],
  };

  function install(loom: Record<string, unknown>) {
    const root = join(h.home, 'pieces');
    mkdirSync(join(root, 'runtime'), { recursive: true });
    mkdirSync(join(root, 'bin'), { recursive: true });
    // A runtime that writes down how core ran it, refuses one recipient, and grants by a file.
    writeFileSync(join(root, 'bin', 'loom-runtime'), `#!/usr/bin/env node
const fs = require('node:fs');
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const argv = process.argv.slice(2);
  if (argv[0] === 'grants') {
    fs.appendFileSync(${JSON.stringify(asked)}, s + '\\n');
    const no = fs.existsSync(${JSON.stringify(join(h.home, 'deny'))});
    return console.log(JSON.stringify(no ? { allow: false, reason: 'mark isn\\'t granted runtime for tools/relay' } : { allow: true }));
  }
  fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv, stdin: JSON.parse(s), grant: process.env.LOOM_STORE_GRANT || null }) + '\\n');
  const a = JSON.parse(s);
  if (a.to === 'fez') { console.log(JSON.stringify({ text: 'relay: no agent fez in this household', isError: true })); process.exit(1); }
  console.log(JSON.stringify({ text: 'r-12345678: ' + a.to + ' has it' }));
});
`);
    chmodSync(join(root, 'bin', 'loom-runtime'), 0o755);
    writeFileSync(join(root, 'runtime', 'piece.json'), JSON.stringify({
      v: 1, name: 'runtime', source: { repo: 'o/r', commit: '1'.repeat(40) }, package: 'loom-runtime', version: '1.0.0', installed: '', bins: ['loom-runtime'],
      loom: { role: 'runtime', settings: [], services: [], ...loom },
    }));
    clearPieceCache();
  }

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-tools-'));
    for (const agent of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', agent), { recursive: true });
      writeFileSync(join(home, 'agents', agent, 'IDENTITY.md'), `# ${agent}\n`);
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art' }));
    h = loadHousehold(home)!;
    seen = join(home, 'seen.jsonl');
    asked = join(home, 'asked.jsonl');
    process.env.LOOM_HOME = home;
    tok.mark = createToken(h, { role: { kind: 'agent', agent: 'mark' }, label: 'mark' }).token;
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
  });
  afterAll(async () => {
    if (saved.home === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved.home;
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'tools-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    return client;
  }
  const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);

  it('a session has no relay tool when no piece offers one', async () => {
    const client = await connect(tok.mark);
    try {
      expect(await names(client)).not.toContain('relay');
      expect(await names(client)).toContain('recall');
    } finally { await client.close(); }
    // An installed piece that offers no tools adds none.
    install({});
    const again = await connect(tok.mark);
    try { expect(await names(again)).not.toContain('relay'); } finally { await again.close(); }
  });

  it('once the runtime offers relay, a new session has it, and a call runs as the session\'s agent', async () => {
    install({ mcp_tools: { relay } });
    const client = await connect(tok.mark);
    try {
      const t = (await client.listTools()).tools.find((x) => x.name === 'relay');
      expect(t?.description).toBe(relay.description);
      expect(t?.inputSchema.properties).toHaveProperty('to');
      const r = await client.callTool({ name: 'relay', arguments: { to: 'art', say: 'hello' } });
      expect(r.isError).toBeFalsy();
      expect((r.content as Array<{ text: string }>)[0].text).toBe('r-12345678: art has it');
      const call = JSON.parse(readFileSync(seen, 'utf-8').trim().split('\n').pop()!);
      expect(call.argv).toEqual(['relay', 'tool', '--agent', 'mark']);
      expect(call.stdin).toEqual({ to: 'art', say: 'hello' });
      expect(readGrant(h.home, call.grant)).toMatchObject({ piece: 'runtime', agent: 'mark' });

      const no = await client.callTool({ name: 'relay', arguments: { to: 'fez', say: 'hi' } });
      expect(no.isError).toBe(true);
      expect((no.content as Array<{ text: string }>)[0].text).toBe('relay: no agent fez in this household');
    } finally { await client.close(); }
  });

  it('asks the grants authority first, and a no never runs the tool', async () => {
    install({ mcp_tools: { relay }, grants: ['loom-runtime', 'grants'] });
    const client = await connect(tok.mark);
    try {
      const ok = await client.callTool({ name: 'relay', arguments: { to: 'art', say: 'one' } });
      expect(ok.isError).toBeFalsy();
      expect(JSON.parse(readFileSync(asked, 'utf-8').trim().split('\n').pop()!)).toEqual({ agent: 'mark', piece: 'runtime', path: 'tools/relay' });
      const before = readFileSync(seen, 'utf-8');
      writeFileSync(join(h.home, 'deny'), '');
      const no = await client.callTool({ name: 'relay', arguments: { to: 'art', say: 'two' } });
      expect(no.isError).toBe(true);
      expect((no.content as Array<{ text: string }>)[0].text).toMatch(/forbidden: mark isn't granted runtime for tools\/relay/);
      expect(readFileSync(seen, 'utf-8')).toBe(before);
    } finally {
      rmSync(join(h.home, 'deny'), { force: true });
      await client.close();
    }
    expect(existsSync(asked)).toBe(true);
  });
});
