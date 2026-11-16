import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStdioServer, isCliInvocation } from '../index.js';
import { isNextStdioInvocation } from './stdio.js';
import { openDb } from '../core/db/index.js';
import { migrateHouseholdTables } from '../core/household/schema.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { closeAllBackends } from '../backends/index.js';

vi.mock('../backends/fastembed.js', () => ({ FastEmbedProvider: class {
  readonly dimensions = 384;
  async embed(text: string) { const v = new Array(384).fill(0); for (let i = 0; i < text.length; i++) v[i % 384] += text.charCodeAt(i) / 1000; return v; }
  async embedBatch(texts: string[]) { return Promise.all(texts.map(t => this.embed(t))); }
} }));
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  closeAllBackends(); vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'loom-stdio-')); homes.push(home);
  for (const agent of ['art', 'mark']) {
    const dir = join(home, 'agents', agent); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'IDENTITY.md'), `I am ${agent}.`);
  }
  const lease = openDb(home); migrateHouseholdTables(lease.db);
  lease.db.transaction(() => new HouseholdDatabase(lease.db).replace(home, { v: 1, agents: ['art', 'mark'], default: 'mark', members: [
    { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'pollock', role: 'owner', agents: ['mark'] },
  ] }))();
  lease.close();
  return home;
}
async function connect(args: string[]) {
  const { server } = createStdioServer(args);
  const client = new Client({ name: 'stdio-acceptance', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  closes.push(async () => { await client.close(); await server.close(); });
  return async (name: string, input: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: input });
    expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
    return (r.content as { text: string }[]).map(c => c.text).join('\n');
  };
}

it('selects only the explicit shared MCP door',()=>{
 expect(isNextStdioInvocation([])).toBe(false);
 expect(isNextStdioInvocation(['serve','--next'])).toBe(false);
 expect(isNextStdioInvocation(['mcp','--next'])).toBe(true);
 expect(isCliInvocation(['node','loom','serve','--next'])).toBe(true);
});

it('leaves the unflagged stdio entrypoint on its existing environment and JSON configuration', async () => {
  const home = fixture();
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'legacy-owner', role: 'owner', agents: '*' }] }));
  vi.stubEnv('LOOM_CONTEXT_DIR', join(home, 'agents/art'));
  const legacy = await connect([]);
  const identity = await legacy('identity');
  expect(identity).toContain('I am art.');
  expect(identity).toContain('`legacy-owner`');
  expect(identity).not.toContain('`jonathan`');
});
