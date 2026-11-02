import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { remember } from './remember.js';
import { forget } from './forget.js';
import { createBackend, closeAllBackends } from '../backends/index.js';
import { openProjectsStore } from '../backends/projects.js';
import { isVisibleInProject, recallNameSet } from '../backends/scope.js';

// Acceptance criterion 9 of docs/specs/projects.md (recall resolves a
// project's names, both ways) and the forget half of 14 (only reads resolve).

describe('recall resolves project names', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-project-recall-'));
  });

  afterEach(() => {
    closeAllBackends();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (input: Parameters<NonNullable<ReturnType<typeof openProjectsStore>>['write']>[0]) => {
    const s = openProjectsStore(dir)!;
    try {
      s.write(input);
    } finally {
      s.close();
    }
  };

  // 'project' memories are project-scoped by default: visible only within their project.
  const seed = async () => {
    const byAlias = await remember(dir, { category: 'project', title: 'waf exception', content: 'the waf exception for the cutover', project: 'on-pond' });
    const bySlug = await remember(dir, { category: 'project', title: 'waf rule', content: 'the waf rule for the cutover', project: 'pond' });
    const other = await remember(dir, { category: 'project', title: 'waf hockey', content: 'the waf for the hockey site', project: 'hockey' });
    return { byAlias: byAlias.ref, bySlug: bySlug.ref, other: other.ref };
  };
  const recallRefs = async (project: string) =>
    (await createBackend(dir).recall({ query: 'waf cutover', project, limit: 10 })).map((m) => m.path);
  const similarRefs = async (project: string) =>
    (await createBackend(dir).findSimilar({ text: 'waf cutover', project, limit: 10 })).map((m) => m.path);

  it('9. recall scoped to pond returns a memory tagged on-pond when on-pond is its alias, and scoped to on-pond returns one tagged pond', async () => {
    const m = await seed();
    write({ slug: 'pond', name: 'Pond', links: { aliases: ['on-pond'] } });
    expect(await recallRefs('pond')).toEqual(expect.arrayContaining([m.byAlias, m.bySlug]));
    expect(await recallRefs('on-pond')).toEqual(expect.arrayContaining([m.byAlias, m.bySlug]));
    expect(await recallRefs('pond')).not.toContain(m.other);
    // find_similar is the other caller of isVisibleInProject.
    expect(await similarRefs('pond')).toEqual(expect.arrayContaining([m.byAlias, m.bySlug]));
  });

  it('9. neither does when the alias is removed', async () => {
    const m = await seed();
    write({ slug: 'pond', name: 'Pond', links: { aliases: ['on-pond'] } });
    write({ slug: 'pond', links: { aliases: null } });
    const pond = await recallRefs('pond');
    expect(pond).toContain(m.bySlug);
    expect(pond).not.toContain(m.byAlias);
    const onPond = await recallRefs('on-pond');
    expect(onPond).toContain(m.byAlias);
    expect(onPond).not.toContain(m.bySlug);
    expect(await similarRefs('pond')).not.toContain(m.byAlias);
  });

  it('9. a name that belongs to no live project keeps the exact match', async () => {
    const m = await seed();
    write({ slug: 'pond', name: 'Pond', links: { aliases: ['on-pond'] } });
    const s = openProjectsStore(dir)!;
    s.archive({ slug: 'pond', reason: 'x', actor: 'art' });
    s.close();
    expect(await recallRefs('pond')).not.toContain(m.byAlias);
    expect(await recallRefs('on-pond')).not.toContain(m.bySlug);
  });

  it('isVisibleInProject takes a name set; a store that can\'t be read keeps the exact name', () => {
    const names = new Set(['pond', 'on-pond']);
    expect(isVisibleInProject({ category: 'project', project: 'on-pond' }, names)).toBe(true);
    expect(isVisibleInProject({ category: 'project', project: 'hockey' }, names)).toBe(false);
    expect(isVisibleInProject({ category: 'user', project: 'hockey' }, names)).toBe(true);
    expect(isVisibleInProject({ category: 'project', project: 'hockey' }, null)).toBe(true);
    expect(recallNameSet('pond', () => { throw new Error('locked'); })).toEqual(new Set(['pond']));
    expect(recallNameSet('pond', () => null)).toEqual(new Set(['pond']));
    expect(recallNameSet(undefined, () => names)).toBeNull();
  });

  it('14. forget({project: "pond"}) leaves a memory tagged on-pond alone', async () => {
    const m = await seed();
    write({ slug: 'pond', name: 'Pond', links: { aliases: ['on-pond'] } });
    const preview = await forget(dir, { project: 'pond' });
    expect(preview).toContain('This would delete 1 memory');
    expect(preview).not.toContain(m.byAlias);
    await forget(dir, { project: 'pond', confirm: true });
    const left = (await createBackend(dir).list({ limit: 100 })).map((e) => e.ref);
    expect(left).toContain(m.byAlias);
    expect(left).not.toContain(m.bySlug);
    // memory_list's project filter is exact too.
    expect((await createBackend(dir).list({ project: 'pond', limit: 100 })).map((e) => e.ref)).toEqual([]);
    expect((await createBackend(dir).list({ project: 'on-pond', limit: 100 })).map((e) => e.ref)).toEqual([m.byAlias]);
  });
});
