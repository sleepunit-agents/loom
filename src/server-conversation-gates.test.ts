import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { bodyHouseConversation, createLoomServer, houseWriteProblem, type LoomServerConfig } from './server.js';
import { bindHouseConversation } from './household-store.js';
import { recordTurn, writeDigest, writeFinding } from './backends/conversations.js';
import { closeAllBackends } from './backends/index.js';
import { openProjectsStore } from './backends/projects.js';
import type { ConversationSelection } from './conversations.js';
import * as conversations from './conversations.js';
import * as households from './household.js';
import * as registry from './household-store.js';

vi.mock('./backends/fastembed.js', () => ({ FastEmbedProvider: class {
  readonly dimensions = 384;
  async embed() { return new Array(384).fill(0); }
  async embedBatch(texts: string[]) { return Promise.all(texts.map(() => this.embed())); }
} }));
const homes: string[] = [];
afterEach(() => { closeAllBackends(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'loom-conversation-gates-')); homes.push(home);
  const household = { home, v: 1 as const, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner' as const, agents: '*' as const }] };
  for (const agent of household.agents) mkdirSync(join(home, 'agents', agent), { recursive: true });
  writeFileSync(join(home, 'household.json'), JSON.stringify(household));
  vi.stubEnv('LOOM_HOME', home);
  return { home, household, contextDir: join(home, 'agents/art') };
}

it('explicit household and standalone gates ignore even a matching legacy runtime binding', () => {
  const { home, household, contextDir } = fixture();
  const conversation = 'cv-000000000001';
  bindHouseConversation(home, { house: 'h-1', agent: 'art', conversation });
  const before = readFileSync(join(home, 'household.db'));
  // Omission keeps the existing runtime binding and cross-agent checks.
  expect(bodyHouseConversation(contextDir, { house: 'h-1' })).toBe(conversation);
  expect(bodyHouseConversation(join(home, 'agents/mark'), { house: 'h-1' })).toBeNull();
  expect(houseWriteProblem(contextDir, { house: 'h-1' }, conversation)).toBeNull();
  for (const selection of [{ household, agent: 'art' }, { household, agent: 'mark' }, null] satisfies ConversationSelection[]) {
    for (const caller of [{ house: 'h-1' }, { house: 'h-1', service: 'discord' }, { service: 'discord' }]) {
      expect(bodyHouseConversation(contextDir, caller, selection)).toBeNull();
      expect(houseWriteProblem(contextDir, caller, conversation, selection)).toContain('holds no conversation');
    }
    expect(bodyHouseConversation(contextDir, undefined, selection)).toBeUndefined();
    expect(houseWriteProblem(contextDir, undefined, conversation, selection)).toBeNull();
  }
  expect(readFileSync(join(home, 'household.db'))).toEqual(before);
});

it('explicit gates need no household JSON or app database, including a service without a house', () => {
  const { home, household, contextDir } = fixture();
  rmSync(join(home, 'household.json'));
  const discovery = [vi.spyOn(conversations, 'homeFor'), vi.spyOn(households, 'householdOf'), vi.spyOn(registry, 'houseConversation')];
  for (const selection of [{ household, agent: 'art' }, null] satisfies ConversationSelection[]) {
    expect(bodyHouseConversation(contextDir, { house: 'h-missing' }, selection)).toBeNull();
    expect(bodyHouseConversation(contextDir, { service: 'discord' }, selection)).toBeNull();
    expect(bodyHouseConversation(contextDir, undefined, selection)).toBeUndefined();
  }
  for (const read of discovery) expect(read).not.toHaveBeenCalled();
  expect(existsSync(join(home, 'household.db'))).toBe(false);
  expect(existsSync(join(home, 'loom.db'))).toBe(false);
});

it('every MCP conversation gate forwards explicit selection instead of trusting the old registry', async () => {
  const { home, household, contextDir } = fixture();
  writeFileSync(join(contextDir, 'IDENTITY.md'), '# Art');
  const { conversation } = recordTurn(contextDir, 'art', {
    venue: 'session', place: 'private', at: new Date().toISOString(), from: { kind: 'agent', id: 'art' }, kind: 'reply',
  }, 'test');
  writeFinding(contextDir, { conversation, seq: 1, measure: 'clarity', score: 1, text: 'private-finding-marker' });
  writeDigest(contextDir, { conversation, run: 'seed' }, { summary: 'private-conversation-marker', projects: ['loom'] });
  const projects = openProjectsStore(contextDir)!;
  projects.write({ slug: 'loom', name: 'Loom' }); projects.close();
  bindHouseConversation(home, { agent: 'art', house: 'h-1', conversation });
  const before = readFileSync(join(home, 'household.db'));
  const binding = vi.spyOn(registry, 'houseConversation');
  for (const caller of [{ house: 'h-1' }, { house: 'h-1', service: 'discord' }, { service: 'discord' }]) {
    const config: LoomServerConfig = { contextDir, caller, conversationSelection: { household, agent: 'art' }, memorySelection: { agent: 'art' }, peopleSelection: null };
    const { server } = createLoomServer(config);
    const client = new Client({ name: 'conversation-gates', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
      const identity = await call('identity', { client: 'claude-code', piece: 'last-24h', conversation, run: 'untrusted-run' });
      for (const result of [identity, await call('episodes'), await call('project_hub', { slug: 'loom' }), await call('conversations'), await call('conversation_findings')]) {
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result.content)).not.toContain('private-conversation-marker');
        expect(JSON.stringify(result.content)).not.toContain('private-finding-marker');
      }
      const list = await call('conversations'); expect(JSON.stringify(list.content)).not.toContain(conversation);
      for (const [name, args] of [
        ['conversation', { id: conversation }], ['conversation_digest', { summary: 'should never be written' }],
        ['comms_title', { title: 'should never be written' }], ['comms_thread', {}],
      ] as const) {
        const result = await call(name, args);
        expect(result.isError, name).toBe(true);
        if (name === 'comms_title') expect(JSON.stringify(result.content)).toContain('holds no conversation the runtime named');
        if (name === 'comms_thread') expect(JSON.stringify(result.content)).toContain('reads only the thread of the conversation it holds');
        expect(binding, name).not.toHaveBeenCalled();
      }
      expect(binding).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  }
  expect(readFileSync(join(home, 'household.db'))).toEqual(before);
}, 30_000);
