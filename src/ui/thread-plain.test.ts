import { describe, expect, it } from 'vitest';
import { clockOf, dayOf, plainThread } from '../../web/src/thread-plain';

// The thread's rows as the agents wrote them (live Activity, 2026-10-30).
const p = (t: string) => { const x = plainThread(t); return [x.title, x.detail ?? '', x.chips.map((c) => c.label).join(', ')]; };

describe('the thread in plain words', () => {
  it('a watch on a pull request says what it did, the round and the task as chips', () => {
    expect(p('t-1498 PR33 nudge-watch round 10 — gave first nudge after 39h silence')).toEqual(['Checked on PR 33', 'Gave first nudge after 39h silence', 't-1498, round 10']);
    expect(p('t-1674 PR385 review-watch round 1')).toEqual(['Watched the review of PR 385', '', 't-1674, round 1']);
    expect(p('Reply-watch round 9: t-1061/t-1063 PR17/PR19 stall flag still silent')).toEqual(['Waited on a reply to PR 17 and PR 19', 'Stall flag still silent', 'round 9, t-1061, t-1063']);
    expect(plainThread('t-1498 PR33 nudge-watch round 10').chips[0]).toEqual({ label: 't-1498', page: 'loom:p/tasks/task/t-1498' });
  });
  it('a lane\'s dated entry says what came of it, the lane as a chip', () => {
    expect(p('knowledge-verify 2026-10-30: 10 pages checked, 1 blocked on secret grant')).toEqual(['10 pages checked, 1 blocked on secret grant', '', 'Knowledge verify']);
    expect(p('reflect 2026-10-29 23:17: clean night, no new findings')).toEqual(['Clean night, no new findings', '', 'Reflect']);
  });
  it('a label before the rest is a chip; a sentence is not', () => {
    expect(p('t-1674 night-shift: built harness_patch')).toEqual(['Built harness_patch', '', 't-1674, Night shift']);
    expect(p('oauth-refresh-token-sentinel: silent watch')).toEqual(['Silent watch', '', 'Oauth refresh token sentinel']);
    expect(p('t-1418 closed as duplicate — fix already landed under t-1414')).toEqual(['Closed as duplicate', 'Fix already landed under t-1414', 't-1418']);
  });
  it('a wake\'s id and a channel\'s name are dropped; the rest stays as written', () => {
    expect(p('w-f335a6 routine 12h check-in: ready queue clean')).toEqual(['Routine 12h check-in', 'Ready queue clean', '']);
    expect(p('#pond: Loren docket rundown for Jonathan')).toEqual(['Loren docket rundown for Jonathan', '', '']);
    expect(p('October 29 evening retro prepared; no substantive change')).toEqual(['October 29 evening retro prepared; no substantive change', '', '']);
  });
  it('days and times read as people say them', () => {
    const now = new Date(2026, 9, 30, 9, 0).getTime();
    expect(dayOf(new Date(2026, 9, 30, 2, 0).toISOString(), now)).toBe('Today');
    expect(dayOf(new Date(2026, 9, 29, 23, 0).toISOString(), now)).toBe('Yesterday');
    expect(dayOf(new Date(2026, 9, 28, 12, 0).toISOString(), now)).toBe('Wed, Oct 28');
    expect(clockOf(new Date(2026, 9, 30, 14, 2).toISOString())).toBe('2:02 PM');
  });
});
