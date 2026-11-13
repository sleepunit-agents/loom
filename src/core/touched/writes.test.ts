import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as notifications from './index.js';
import { SqliteKnowledgeBackend } from '../../backends/sqlite-knowledge.js';
import { SqliteVecBackend } from '../../backends/sqlite-vec.js';
const dirs: string[] = [], closes: (() => void)[] = [];
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'touch-write-')); dirs.push(dir); mkdirSync(join(dir, '.loom-live')); writeFileSync(notifications.touchSocketPath(dir), 'test marker'); return dir; };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of closes.splice(0)) close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const knowledgeVerbs = ['writePage', 'archivePage', 'restorePage', 'supersedePage', 'movePage', 'mergePages', 'purgePages', 'verifyPages', 'restoreRevision', 'addCitations'] as const;
it.each(knowledgeVerbs)('knowledge %s announces every affected slug after success', async verb => {
  const dir = home(), backend = new SqliteKnowledgeBackend({ dbPath: join(dir, 'knowledge.db') }); closes.push(() => backend.close());
  const sent = vi.spyOn(notifications, 'touched').mockImplementation(() => {});
  const page = { slug: 'source', title: 'Source', domain: 'test', body: 'original' };
  await backend.writePage(page); await backend.writePage({ ...page, slug: 'target', title: 'Target' });
  if (verb === 'restorePage' || verb === 'purgePages') await backend.archivePage({ slug: 'source' });
  if (verb === 'restoreRevision') await backend.writePage({ ...page, body: 'changed', bodyMode: 'replace' });
  const revisions = await backend.listRevisions('source');
  sent.mockClear();
  let expected = ['source'];
  switch (verb) {
    case 'writePage': await backend.writePage({ ...page, body: 'changed' }); break;
    case 'archivePage': await backend.archivePage({ slug: 'source' }); break;
    case 'restorePage': await backend.restorePage({ slug: 'source' }); break;
    case 'purgePages': await backend.purgePages({ slugs: ['source'], confirm: true }); break;
    case 'verifyPages': await backend.verifyPages({ slugs: ['source', 'target'] }); expected.push('target'); break;
    case 'restoreRevision': await backend.restoreRevision({ slug: 'source', revision_id: revisions[0].id }); break;
    case 'addCitations': await backend.addCitations('source', [{ claim: 'fact', source_kind: 'web', source_locator: 'https://example.com', excerpt: 'fact' }]); break;
    case 'supersedePage': await backend.supersedePage({ old_slug: 'source', new_slug: 'target' }); expected.push('target'); break;
    case 'mergePages': await backend.mergePages({ source_slugs: ['source'], target_slug: 'target' }); expected.push('target'); break;
    case 'movePage': await backend.movePage({ slug: 'source', new_slug: 'renamed' }); expected.push('renamed'); break;
  }
  expect(sent.mock.calls.map(c => c[2]).sort()).toEqual(expected.sort());
  expect(sent.mock.calls.every(c => c[0] === dir && c[1] === 'knowledge')).toBe(true);
  sent.mockClear();
  await expect(backend.addCitations('missing', [])).rejects.toThrow();
  expect(sent).not.toHaveBeenCalled();
});
const memoryVerbs = ['remember', 'forget', 'update', 'prune', 'archive', 'restore', 'restoreRevision', 'supersede', 'mergeMemories'] as const;
it.each(memoryVerbs)('memory %s announces affected refs after success', async verb => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
  const dir = home(), backend = new SqliteVecBackend({ dbPath: join(dir, 'memories.db') }, { dimensions: 4, embed: async () => [1, 0, 0, 0], embedBatch: async texts => texts.map(() => [1, 0, 0, 0]) }); closes.push(() => backend.close());
  const sent = vi.spyOn(notifications, 'touched').mockImplementation(() => {});
  const page = { category: 'project', title: 'Source', content: 'original', ttl: verb === 'prune' ? '1h' : 'permanent' };
  const source = await backend.remember(page), target = await backend.remember({ ...page, title: 'Target', content: 'different', ttl: 'permanent' });
  if (verb === 'restore') await backend.archive({ ref: source.ref });
  if (verb === 'restoreRevision') await backend.update({ ref: source.ref, content: 'changed' });
  const revisions = await backend.listRevisions(source.ref);
  sent.mockClear();
  let expected = [source.ref];
  switch (verb) {
    case 'remember': await backend.remember(page); break;
    case 'forget': await backend.forget({ ref: source.ref }); break;
    case 'update': await backend.update({ ref: source.ref, content: 'updated' }); break;
    case 'prune':
      vi.setSystemTime(new Date('2026-11-12T02:00:00Z'));
      await backend.prune({ dryRun: true }); expect(sent).not.toHaveBeenCalled();
      await backend.prune(); break;
    case 'archive': await backend.archive({ ref: source.ref }); break;
    case 'restore': await backend.restore({ ref: source.ref }); break;
    case 'restoreRevision': await backend.restoreRevision({ ref: source.ref, revision_id: revisions[0].id }); break;
    case 'supersede': await backend.supersede({ old_ref: source.ref, new_ref: target.ref }); expected.push(target.ref); break;
    case 'mergeMemories': await backend.mergeMemories({ source_refs: [source.ref], target_ref: target.ref }); expected.push(target.ref); break;
  }
  expect(sent.mock.calls.map(c => c[2]).sort()).toEqual(expected.sort());
  expect(sent.mock.calls.every(c => c[0] === dir && c[1] === 'memory')).toBe(true);
});
it('does not inspect a mutation result without a daemon', async () => {
  const { notifyWrites } = await import('./writes.js');
  const dir = mkdtempSync(join(tmpdir(), 'touch-offline-')); dirs.push(dir);
  const result = Object.defineProperty({}, 'ref', { enumerable: true, get() { throw new Error('result inspected'); } });
  const store = { write: () => result };
  notifyWrites(store, join(dir, 'memories.db'), 'memory', ['write'], ['ref']);
  expect(store.write()).toBe(result);
});

it('does not evaluate excluded body or metadata properties while collecting identities', async () => {
  const { identities } = await import('./writes.js');
  const result = { slug: 'right', get body() { throw new Error('body read'); }, get metadata() { throw new Error('metadata read'); } };
  expect(identities(result, new Set(['slug']))).toEqual(['right']);
});
