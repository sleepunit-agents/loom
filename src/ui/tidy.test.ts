import { describe, expect, it } from 'vitest';
import { tidy } from '../../web/src/tidy';

// What agents wrote, as loom's pages showed it on 2026-10-30.
const now = new Date(2026, 9, 30, 9, 0);
const t = (s: string) => tidy(s, now);

describe('an agent\'s words, tidied for reading', () => {
  it('drops the ids nobody reads, and what they leave behind', () => {
    expect(t('2026-10-30 wake w-6b2931 round 1: worktree built fresh')).toBe('Oct 30 wake round 1: worktree built fresh');
    expect(t('Wake: unparked (a-24e194de allowed): homelab DNS health check')).toBe('Wake: unparked (allowed): homelab DNS health check');
    expect(t('Loren DM: asked S11 run-move yes/no (r-d8dad1d1)')).toBe('Loren DM: asked S11 run-move yes/no');
    expect(t('watch h-423 for schedule planning-post')).toBe('watch for schedule planning-post');
    expect(t('t-1586: seed WX site (q-7c3f35ab granted)')).toBe('t-1586: seed WX site (granted)');
  });
  it('keeps what people use: tasks, PRs, conversations, hashes in prose', () => {
    expect(t('t-1683 PR202 nudge-watch round 4')).toBe('t-1683 PR202 nudge-watch round 4');
    expect(t('on-pond#178 is MERGED (3db4989a)')).toBe('on-pond#178 is MERGED (3db4989a)');
    expect(t('conv c-0001')).toBe('conv c-0001');
  });
  it('reads dates and stamped times as dates and times, in local time; a date in a file name stays', () => {
    expect(t('Continuity pass 2026-10-30')).toBe('Continuity pass Oct 30');
    expect(t('plan 2026-10-30 08:31 — DNS fixed')).toBe('plan Oct 30, 8:31 AM — DNS fixed');
    expect(t('stale claim since 2025-12-20')).toBe('stale claim since Dec 20, 2025');
    expect(t('merged 2026-10-28T16:44:52Z')).toBe(`merged ${tidy('2026-10-28T16:44:52Z', now)}`);
    expect(t('merged 2026-10-28T16:44:52Z')).toMatch(/^merged Oct 28, \d{1,2}:44 (AM|PM)$/);
    expect(t('Brief: notes/onterris/2026-10-29-t1682-livonia-to-stable-brief.md')).toBe('Brief: notes/onterris/2026-10-29-t1682-livonia-to-stable-brief.md');
    expect(t('see 2026-10-29-arearae-brief.md')).toBe('see 2026-10-29-arearae-brief.md');
    expect(t('not a date 2026-13-45')).toBe('not a date 2026-13-45');
  });
  it('leaves plain words alone', () => {
    expect(t('Jonathan asked about Livonia S07: AreaRAE silent, box online')).toBe('Jonathan asked about Livonia S07: AreaRAE silent, box online');
  });
});
