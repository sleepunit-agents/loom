import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECORD_ID } from './contract.js';
import { admits } from './viewer.js';
import { checkAnswer } from './serve.js';
import { CORE_TYPES, coreAnswers } from './core-types.js';
import { listProjects } from '../tools/project.js';
import { openProjectsStore } from '../backends/projects.js';
import type { Household } from '../household.js';
import type { ProviderQuery } from './memory.js';
import type { Viewer } from './viewer.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const OWNER: Viewer = { kind: 'member', person: 'jonathan', household: true, agents: ['art', 'mark'] };
const query = (extra: Partial<ProviderQuery> = {}): ProviderQuery => ({ id: 'q', type: 'project', version: 1, where: [], order: [['agent', 'asc'], ['slug', 'asc']], limit: 500, after: null, fields: ['agent', 'slug', 'name', 'status', 'links', 'activity', 'updated', 'synthesized_at', 'stale', 'unverified', 'memories_since_synthesis', 'unreadable'], aggregates: [], ...extra });

describe('shared project directory', () => {
  let home: string;
  let h: Household;
  const dir = (agent: string) => join(home, 'agents', agent);
  const write = (agent: string, slug: string, name: string, status: 'active' | 'paused' | 'done' = 'active') => {
    const s = openProjectsStore(dir(agent), { now: () => NOW })!;
    try { s.write({ slug, name, status, summary: 'Project', links: { epic: 't-1', aliases: ['alias-' + slug] } }); } finally { s.close(); }
  };
  const ask = async (viewer: Viewer = OWNER, q = query()) => (await coreAnswers(h, viewer, [q], NOW))[0];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-project-records-'));
    for (const a of ['art', 'mark']) mkdirSync(dir(a), { recursive: true });
    h = { home, agents: ['art', 'mark'] } as Household;
    write('art', 'same', 'Art project');
    write('mark', 'same', 'Mark project', 'paused');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('matches project_list field for field and keeps identical slugs in different agents separate', async () => {
    const a = await ask();
    expect(a.rows).toEqual(['art', 'mark'].flatMap((agent) => listProjects(dir(agent), { nowMs: NOW }).map((p) => {
      const r: Record<string, unknown> = { id: `${agent}:${p.slug}`, audience: { owners: true } };
      for (const f of query().fields) if (f === 'agent') r.agent = agent;
      else if (Object.hasOwn(p, f)) r[f] = (p as unknown as Record<string, unknown>)[f];
      return r;
    })));
    expect(a.total).toEqual({ n: 2, exact: true });
  });

  it('decides visibility before filters, paging and totals; agents and unknown owners get no rows', async () => {
    const art: Viewer = { kind: 'member', person: 'sam', household: false, agents: ['art', 'removed'] };
    expect((await ask(art)).rows).toEqual([]);
    expect((await ask(art)).total).toEqual({ n: 0, exact: true });
    for (const r of (await ask({ kind: 'core' })).rows) {
      expect(RECORD_ID.test(String(r.id))).toBe(true);
      expect(admits(art, r.audience as { owners: true }, String(r.agent), CORE_TYPES.project)).toBe(false);
      expect(admits(OWNER, r.audience as { owners: true }, String(r.agent), CORE_TYPES.project)).toBe(true);
    }
    expect((await ask(art, query({ where: [['agent', 'eq', 'mark']] }))).total).toEqual({ n: 0, exact: true });
    for (const viewer of [{ kind: 'agent', agent: 'art' }, { kind: 'core' }, { kind: 'member', person: 'nobody', household: false, agents: [] }] as Viewer[]) {
      expect((await ask(viewer)).rows.length).toBe(viewer.kind === 'core' ? 2 : 0);
    }
  });

  it('survives the real served-answer validation and produces canonical record keys', async () => {
    const q = query();
    const a = await ask();
    const served = checkAnswer(OWNER, { name: 'loom', owners2: false, types: CORE_TYPES },
      { ...q, provider: 'loom', major: 1, withheld: [], subscribe: false }, a, 1_048_576, NOW, (x) => x);
    expect(served).toMatchObject({ id: 'q', rows: [
      { key: 'loom/project/art:same', name: 'Art project' },
      { key: 'loom/project/mark:same', name: 'Mark project' },
    ] });
  });

  it('paginates stable identities, filters status and updates names without a second source', async () => {
    const first = await ask(OWNER, query({ limit: 1 }));
    expect(first.more).toBe(true);
    const second = await ask(OWNER, query({ limit: 1, after: ['art', 'same', 'art:same'] }));
    expect(second.rows.map((r) => r.id)).toEqual(['mark:same']);
    expect(second.more).toBe(false);
    write('art', 'same', 'Renamed');
    expect((await ask(OWNER, query({ where: [['status', 'eq', 'active']] }))).rows.map((r) => r.name)).toEqual(['Renamed']);
  });

  it('removes archived projects and restores the same record identity', async () => {
    const s = openProjectsStore(dir('art'))!;
    try { s.archive({ slug: 'same', reason: 'Finished', actor: 'art' }); } finally { s.close(); }
    expect((await ask()).rows.map((r) => r.id)).toEqual(['mark:same']);
    const restored = openProjectsStore(dir('art'))!;
    try { restored.restore({ slug: 'same' }); } finally { restored.close(); }
    expect((await ask()).rows.map((r) => r.id)).toEqual(['art:same', 'mark:same']);
  });
});
