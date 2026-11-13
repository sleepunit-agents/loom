import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { recordTurn, writeDigest } from '../backends/conversations.js';
import { conversationView, conversationsList, homeFor } from '../conversations.js';
import { openProjectsStore } from '../backends/projects.js';
import { personWrite } from '../tools/person.js';
import { projectHub } from '../tools/project.js';
import { createLoomServer } from '../server.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'loom-conversation-context-')); homes.push(home);
  const household = { home, v: 1 as const, agents: ['art', 'mark'], default: 'mark', members: [{ person: 'jonathan', role: 'owner' as const, agents: '*' as const }] };
  const selections = household.agents.map(agent => {
    const contextDir = join(home, 'agents', agent); mkdirSync(contextDir, { recursive: true });
    const { conversation } = recordTurn(contextDir, agent, {
      venue: 'external', place: agent, label: `${agent} conversation`,
      at: '2026-11-12T12:00:00.000Z', from: { kind: 'agent', id: agent }, kind: 'message',
    }, 'test');
    return { contextDir, conversation, selection: { household, agent } };
  });
  return { home, selections };
}

it('explicit readers use generic rendering for two agents without creating the legacy app registry', async () => {
  const { home, selections } = fixture();
  for (const { contextDir, conversation, selection } of selections) {
    expect(homeFor(contextDir, {}, selection)).toBe(home);
    const list = conversationsList(contextDir, {}, { LOOM_HOME: home }, selection);
    expect(list).toHaveLength(1); expect(list[0].label).toBe(`${selection.agent} conversation`);
    const view = await conversationView(contextDir, selection.agent, conversation, { LOOM_HOME: home }, selection);
    expect(view?.render.by).toBe('core'); expect(view?.conversation.venue_label).toBe('external');
    const { server } = createLoomServer({ contextDir, conversationSelection: selection });
    const client = new Client({ name: 'continuity', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      for (const [name, args] of [['conversations', {}], ['conversation', { id: conversation }]] as const) {
        const r = await client.callTool({ name, arguments: args }); expect(r.isError).not.toBe(true);
        expect(JSON.stringify(r.content)).toContain(`${selection.agent} conversation`);
        expect(JSON.stringify(r.content)).not.toContain(`${selection.agent === 'art' ? 'mark' : 'art'} conversation`);
      }
    } finally { await client.close(); await server.close(); }
  }
  expect(existsSync(join(home, 'household.db'))).toBe(false);
  expect(existsSync(join(home, 'household.json'))).toBe(false);
});

it('explicit standalone ignores neighbouring JSON and env while omitted readers retain discovery', async () => {
  const { home, selections: [art] } = fixture();
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner' as const, agents: '*' as const }] }));
  expect(homeFor(art.contextDir, { LOOM_HOME: '/other' }, null)).toBeUndefined();
  expect(homeFor(art.contextDir, { LOOM_HOME: '/other' })).toBe(home);
  const view = await conversationView(art.contextDir, 'art', art.conversation, { LOOM_HOME: home }, null);
  expect(view?.render.by).toBe('core');
  expect(existsSync(join(home, 'household.db'))).toBe(false);
});


it('explicit project hubs read each agent core conversations and selected People without opening the legacy app', async () => {
  const { home, selections } = fixture();
  // A legacy app database must never be opened, even if old metadata and env point here.
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'mark', members: [] }));
  writeFileSync(join(home, 'household.db'), 'unavailable legacy app');
  for (const { contextDir, conversation, selection } of selections) {
    const projects = openProjectsStore(contextDir)!;
    projects.write({ slug: 'loom', name: 'Loom' }); projects.close();
    await personWrite(contextDir, { slug: 'jonathan', name: 'Jonathan', where: { loom: { value: `${selection.agent} relationship` } } }, selection);
    writeDigest(contextDir, { conversation, run: 'run-project' }, { summary: `${selection.agent} work`, projects: ['loom'] });
    const result = await projectHub(contextDir, { slug: 'loom' }, { peopleSelection: selection, conversationSelection: selection });
    expect(result).not.toContain('error');
    expect(result).toContain(`${selection.agent} work`);
    expect(result).toContain(`${selection.agent} relationship`);
    expect(result).not.toContain(`${selection.agent === 'art' ? 'mark' : 'art'} work`);
    expect(result).not.toContain('piece:');
    const { server } = createLoomServer({ contextDir, peopleSelection: selection, conversationSelection: selection });
    const client = new Client({ name: 'project-continuity', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      const reply = await client.callTool({ name: 'project_hub', arguments: { slug: 'loom' } });
      expect(JSON.stringify(reply.content)).toContain(`${selection.agent} relationship`);
      expect(JSON.stringify(reply.content)).toContain(`${selection.agent} work`);
      expect(JSON.stringify(reply.content)).not.toContain('error');
    } finally { await client.close(); await server.close(); }
    const standalone = await projectHub(contextDir, { slug: 'loom' }, { peopleSelection: null, conversationSelection: null });
    expect(standalone).toContain(`${selection.agent} work`);
    expect(standalone).not.toContain('error');
  }
});
