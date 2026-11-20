import { afterEach, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/index.js';
import { fixtureSharing } from '../fixture.js';
import { registerOperationTools } from './operation-tools.js';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('offers registry operations through MCP, preserves viewer policy, and shares retries with HTTP/direct', async () => {
  const home = mkdtempSync(join(tmpdir(),'loom-operation-tools-')); cleanup.push(() => rmSync(home,{recursive:true,force:true}));
  const app = await startLoom({ home, clock: new FakeClock(), sharing: fixtureSharing }); cleanup.push(app.close);
  const server = new McpServer({ name: 'fixture', version: '1' });
  registerOperationTools(server, app.operations, { kind: 'member', id: 'pollock' });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
  const client = new Client({ name: 'fixture-client', version: '1' }); await client.connect(b);
  cleanup.push(async () => { await client.close(); await server.close(); });
  expect((await client.listTools()).tools.map(t => t.name)).toContain('tasks.close');
  const input = { title: 'Shared', project: 'pond', actor: 'pollock', at: '2026-11-12T00:00:00.000Z' };
  const result = await client.callTool({ name: 'tasks.create', arguments: { input, id: 'create' } });
  const value = JSON.parse((result.content as { text: string }[])[0].text);
  expect(value).toMatchObject({ ok: true, value: { result: { ok: true, id: 't-1' } } });
  expect(app.operations.call('http', { kind: 'member', id: 'pollock' }, 'tasks.create', input, 'create')).toEqual(value);
  const denied = await client.callTool({ name: 'tasks.create', arguments: { input: { ...input, project: 'other' }, id: 'denied' } });
  expect(denied.isError).toBe(true);
  expect(JSON.parse((denied.content as { text: string }[])[0].text)).toMatchObject({ ok: false, code: 'denied' });
  expect((app.db.prepare('SELECT count(*) AS n FROM tasks_tasks').get() as {n:number}).n).toBe(1);
});

import { installHouseholdTasks, registerSessionOperations } from './task-composition.js';
import type { Household, Role } from '../household.js';

// These tools exist only on the new side.
beforeAll(() => { process.env.LOOM_NEXT = '1'; });
afterAll(() => { delete process.env.LOOM_NEXT; });

it('offers no operation tools on today\'s loom', () => {
  delete process.env.LOOM_NEXT;
  const names: string[] = [];
  const server = { registerTool: (name: string) => { names.push(name); } } as never;
  try { registerSessionOperations(server, {} as never, { role: { kind: 'agent', agent: 'art' } as never }, () => undefined); }
  finally { process.env.LOOM_NEXT = '1'; }
  expect(names).toEqual([]);
});
it('production composition derives ownership and binds authenticated owner/agent viewers; anonymous and peer get no operations', async () => {
  const home = mkdtempSync(join(tmpdir(),'loom-task-composition-')); cleanup.push(() => rmSync(home,{recursive:true,force:true}));
  const household: Household = { home, agents: ['art','mark'], default: 'art', members: [
    { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'pollock', role: 'owner', agents: ['mark'] },
  ] };
  const app = await startLoom({ home, clock: new FakeClock(), install: f => installHouseholdTasks(f, () => household) }); cleanup.push(app.close);
  const make = (title: string, scope = {}) => app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'tasks.create', { title, actor: 'art', at: '2026-11-12T00:00:00.000Z', ...scope }, title);
  expect(make('Unfiled').ok).toBe(true); expect(make('Art own', {agent:'art'}).ok).toBe(true); expect(make('Mark own', {agent:'mark'}).ok).toBe(true); expect(make('No project grants', {project:'pond'}).ok).toBe(true);
  for (const [role, ids] of [
    [{ kind: 'owner' }, ['t-1','t-2','t-3','t-4']],
    [{ kind: 'owner', member: 'pollock' }, ['t-3']],
    [{ kind: 'agent', agent: 'art' }, ['t-2']],
    [{ kind: 'peer', name: 'guest' }, undefined],
    [undefined, undefined],
  ] as [Role | undefined, string[] | undefined][]) {
    const server = new McpServer({ name: 'fixture', version: '1' });
    registerSessionOperations(server, app, role ? { role } : undefined, () => household);
    const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
    const client = new Client({ name: 'fixture-client', version: '1' }); await client.connect(b);
    try {
      if (ids === undefined) { await expect(client.listTools()).rejects.toThrow(); continue; }
      const r = await client.callTool({ name: 'tasks.list', arguments: { input: {} } });
      const value = JSON.parse((r.content as {text:string}[])[0].text);
      expect(value.value.result.entries.map((t: {id:string}) => t.id)).toEqual(ids);
    } finally { await client.close(); await server.close(); }
  }
});
