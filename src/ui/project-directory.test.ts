import { describe, it, expect } from 'vitest';
import { projectDirectory } from '../../web/src/project-directory';
import type { ProjectCards, ProjectCardView } from './project-cards';
import type { Rec } from '../../web/src/collections/runtime';
const card = (agent: string, status = 'active'): ProjectCardView => ({ agent, slug: 'same', name: `${agent} before`, status,
  directoryUpdated: '2026-11-09T12:00:00Z', page: `projects/${agent}/same`, activity: '2026-11-09T12:00:00Z', repos: ['old/repo'], people: [{ name: agent, person: 'someone' }], what: 'A real summary', lately: [{ text: 'Recent task', ago: '1h', status: 'Open' }], spark: { days: [1, 2], label: '3 things' },
  ...(status === 'active' ? { waiting: { count: 2, items: ['Please decide'] }, changes: { open: 1, failing: 1, running: 0, line: '1 open · 1 failing' } } : {}) });
const cards: ProjectCards = { active: [card('art')], quiet: [card('mark', 'paused')], waiting: 2 };
const rec = (agent: string, status = 'active'): Rec => ({ key: `loom/project/${agent}:same`, agent, slug: 'same', name: `${agent} after`, status,
  updated: '2026-11-09T12:00:00Z', activity: '2026-11-10T12:00:00Z', links: { repos: ['github:new/repo'] } });
const rows = (...rs: Rec[]) => new Map(rs.map((r) => [r.key, r]));
describe('Projects cards join the whole live directory', () => {
  it('renames and changes repos/activity independently for identical slugs, preserving source-owned active feed details', () => {
    const got = projectDirectory(cards, rows(rec('art'), rec('mark', 'paused')));
    expect(got.active[0]).toMatchObject({ name: 'art after', repos: ['new/repo'], activity: '2026-11-10T12:00:00Z', waiting: cards.active[0].waiting, changes: cards.active[0].changes });
    expect(got.quiet[0]).toMatchObject({ name: 'mark after', status: 'paused', page: 'projects/mark/same' });
    expect(got.waiting).toBe(2);
    for (const field of ['what', 'people', 'lately', 'spark', 'waiting', 'changes'] as const) expect(got.active[0][field]).toEqual(cards.active[0][field]);
    expect(cards.active[0].name).toBe('art before');
  });
  it('adds cards, removes archived/deleted cards, moves quiet/active cards and never invents a waiting count', () => {
    const got = projectDirectory(cards, rows(rec('art', 'done'), rec('mark'), rec('new')));
    expect(got.active.map((c) => c.agent)).toEqual(['mark', 'new']);
    for (const c of got.active) expect(c.waiting).toHaveProperty('unknown');
    expect(got.quiet[0]).toMatchObject({ agent: 'art', status: 'done', lately: [] });
    expect(got.quiet[0].waiting).toBeUndefined();
    expect(got.quiet[0].changes).toBeUndefined();
    expect(got.waiting).toBe(0);
    expect(projectDirectory(cards, rows(rec('new'))).active.map((c) => c.agent)).toEqual(['new']);
    expect(projectDirectory(cards, rows())).toEqual({ active: [], quiet: [], waiting: 0 });
  });
  it('every window refuses old page feeds after a card revision, even when it missed an intervening quiet/archive state', () => {
    const changed = rows({ ...rec('art'), updated: '2026-11-10T12:00:00Z' });
    for (const page of [cards, structuredClone(cards)]) {
      const active = projectDirectory(page, changed).active[0];
      expect(active.waiting).toHaveProperty('unknown');
      expect(active.lately).toEqual([]); expect(active.changes).toBeUndefined(); expect(active.spark).toBeUndefined();
    }
    const fresh = structuredClone(cards); fresh.active[0].directoryUpdated = '2026-11-10T12:00:00Z';
    expect(projectDirectory(fresh, changed).active[0].waiting).toEqual(cards.active[0].waiting);
    const legacy = structuredClone(cards); delete legacy.active[0].directoryUpdated;
    expect(projectDirectory(legacy, rows(rec('art'))).active[0].waiting).toHaveProperty('unknown');
  });
  it('keeps the page while the directory is loading, partial, stale or refused', () => {
    expect(projectDirectory(cards, null)).toBe(cards);
  });
  it('sorts waiting, unknown, then quiet work by activity as the page does', () => {
    const got = projectDirectory(cards, rows(rec('new'), rec('art'), { ...rec('other'), activity: '2026-11-11T12:00:00Z' }));
    expect(got.active.map((c) => c.agent)).toEqual(['art', 'other', 'new']);
    expect(projectDirectory(cards, rows(rec('old', 'paused'), { ...rec('new', 'done'), activity: '2026-11-11T12:00:00Z' })).quiet.map((c) => c.agent)).toEqual(['new', 'old']);
  });
});
