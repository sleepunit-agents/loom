/**
 * What a digest's needs_owner asks the owner (needs.ts): the object (ask, why, if_yes, if_no, href, refs, waits_on),
 * a plain string as before, and the lint that refuses an ask the owner can't read, saying why.
 */
import { describe, expect, it } from 'vitest';
import { lintAsk, needsOfRow, parseNeeds, refsIn, type NeedsOwner } from './needs.js';

// The one in Jonathan's Inbox on 2026-11-03: "I don't know wtf that wants from me."
const STALE = "Allow local-wake card a-7693c00e on loom's Home so Art can set up the rclone→Drive backup for t-40 (round 9)";
const GOOD = {
  ask: "OK to install rclone and restic on loom's machine to set up the Google Drive backup?",
  why: 'The nightly backup has no offsite copy yet.',
  if_yes: 'I install both and run the first backup tonight.',
  if_no: 'Backups stay on this machine only.',
  refs: ['t-40', 'a-7693c00e'],
};

const ok = (v: ReturnType<typeof parseNeeds>): NeedsOwner => {
  if (typeof v === 'string' || v === null) throw new Error(`expected an ask, got ${JSON.stringify(v)}`);
  return v;
};

describe('the lint: an ask names no internal ids or lane words', () => {
  it('finds each of them, as written', () => {
    expect(lintAsk(STALE, false)).toEqual(['a-7693c00e', 'round 9', 'local-wake']);
    expect(lintAsk('cv-9969daf1e77c dg-2928d600d5dc h-888 w-6d5807 nudge-watch chain-check Round 3', false))
      .toEqual(['cv-9969daf1e77c', 'dg-2928d600d5dc', 'w-6d5807', 'h-888', 'Round 3', 'nudge-watch', 'chain-check']);
  });
  it('an object\'s ask names no task or pull request either: those are refs', () => {
    expect(lintAsk('Merge art#68 for t-1735?', true)).toEqual(['t-1735', 'art#68']);
    expect(lintAsk('Merge sleepunit-agents/art#68?', true)).toEqual(['sleepunit-agents/art#68']);
    expect(lintAsk('Merge art#68 for t-1735?', false)).toEqual([]);
  });
  it('plain words pass, words that only look close too', () => {
    for (const s of [GOOD.ask, 'Pick a date for the a-team offsite', 'Is the h-bridge order right?', 'Three rounds of review are done: merge it?', 'Is 2 a round number?']) {
      expect(lintAsk(s, true), s).toEqual([]);
    }
  });
});

describe('needs_owner as the object', () => {
  it('takes it whole, and an approval in refs is what it waits on', () => {
    expect(ok(parseNeeds(GOOD, undefined))).toEqual({ ...GOOD, waits_on: { approval: 'a-7693c00e' } });
  });
  it('refuses an ask with ids, saying which and how to say it instead', () => {
    const r = parseNeeds({ ...GOOD, ask: STALE.slice(0, 140) }, undefined);
    expect(typeof r).toBe('string');
    expect(r).toContain('"a-7693c00e"');
    expect(r).toContain('"local-wake"');
    expect(r).toContain('needs_owner.refs');
    expect(r).toContain('"ask": "OK to install rclone');
    expect(parseNeeds({ ask: 'Merge art#68?' }, undefined)).toMatch(/can't name "art#68"/);
  });
  it('waits on an approval or a task, said outright; never a pull request (loom can\'t read GitHub)', () => {
    expect(ok(parseNeeds({ ask: 'Close out the backup work?', waits_on: { task: 't-40' } }, undefined))).toEqual({ ask: 'Close out the backup work?', refs: ['t-40'], waits_on: { task: 't-40' } });
    expect(ok(parseNeeds({ ask: 'Allow the install?', refs: ['a-11111111', 'a-22222222'], waits_on: { approval: 'a-22222222' } }, undefined)).waits_on).toEqual({ approval: 'a-22222222' });
    // Two approvals and no word on which: it waits on neither.
    expect(ok(parseNeeds({ ask: 'Allow the install?', refs: ['a-11111111', 'a-22222222'] }, undefined)).waits_on).toBeUndefined();
    expect(parseNeeds({ ask: 'Merge the fix?', waits_on: { pr: 'sleepunit-agents/art#68' } }, undefined)).toMatch(/can't be a pull request: loom has no way to read GitHub/);
    for (const w of [{}, { approval: 'a-1' }, { task: '40' }, { approval: 'a-11111111', task: 't-1' }, 'a-11111111']) {
      expect(typeof parseNeeds({ ask: 'Allow it?', waits_on: w }, undefined), JSON.stringify(w)).toBe('string');
    }
  });
  it('holds each part to its size and shape', () => {
    expect(ok(parseNeeds({ ask: 'x'.repeat(140) }, undefined)).ask).toHaveLength(140);
    expect(parseNeeds({ ask: 'x'.repeat(141) }, undefined)).toMatch(/at most 140/);
    expect(parseNeeds({ ask: 'Two\nlines?' }, undefined)).toMatch(/one line/);
    expect(parseNeeds({ ask: 'OK?', why: 'y'.repeat(241) }, undefined)).toMatch(/why is one line of at most 240/);
    expect(parseNeeds({ ask: 'OK?', if_no: 'n'.repeat(141) }, undefined)).toMatch(/if_no/);
    expect(parseNeeds({ ask: 'OK?', refs: ['the backup'] }, undefined)).toMatch(/refs is a list/);
    expect(parseNeeds({ ask: 'OK?', refs: Array.from({ length: 9 }, (_, n) => `t-${n}`) }, undefined)).toMatch(/at most 8/);
    expect(parseNeeds({ ask: 'OK?', title: 'x' }, undefined)).toMatch(/no key "title"/);
    expect(parseNeeds({ ask: 'OK?', href: 'http://example.com' }, undefined)).toMatch(/https/);
    expect(parseNeeds({ why: 'no ask' }, undefined)).toMatch(/ask is one plain question/);
  });
  it('takes the link as href or the older needs_owner_href, once', () => {
    const pr = 'https://github.com/sleepunit-agents/art/pull/68';
    expect(ok(parseNeeds({ ask: 'Merge the Slack brief change?', refs: ['sleepunit-agents/art#68'] }, pr)).href).toBe(pr);
    expect(ok(parseNeeds({ ask: 'Merge the Slack brief change?', href: pr }, pr)).href).toBe(pr);
    expect(parseNeeds({ ask: 'Merge it?', href: pr }, 'https://github.com/sleepunit-agents/art/pull/69')).toMatch(/give the link once/);
  });
});

describe('needs_owner as a plain string, as before', () => {
  it('is the ask alone, and keeps a pull request or task it names (it has no refs to put them in)', () => {
    expect(ok(parseNeeds('Review/merge art#68 (Slack brief: on-behalf requests as digests, two-way door)', 'https://github.com/sleepunit-agents/art/pull/68'))).toEqual({
      ask: 'Review/merge art#68 (Slack brief: on-behalf requests as digests, two-way door)', refs: ['art#68'],
      href: 'https://github.com/sleepunit-agents/art/pull/68', legacy: true,
    });
  });
  it('refuses internal ids and lane words, pointing at the object', () => {
    const r = parseNeeds(STALE, undefined);
    expect(r).toMatch(/can't name "a-7693c00e", "round 9", "local-wake"/);
    expect(r).toContain('Write needs_owner as an object');
  });
  it('null is no ask, and a link alone is refused', () => {
    expect(parseNeeds(null, undefined)).toBeNull();
    expect(parseNeeds(undefined, null)).toBeNull();
    expect(parseNeeds(null, 'https://github.com/x/y/pull/1')).toMatch(/goes with needs_owner/);
  });
});

describe('what a stored digest asks', () => {
  it('a stored object reads back whole', () => {
    const n = ok(parseNeeds(GOOD, undefined));
    expect(needsOfRow({ needs_owner: n.ask, needs_owner_json: JSON.stringify(n) })).toEqual(n);
  });
  it('a string stored before the lint reads its refs from its words, and waits on the one approval it names', () => {
    expect(needsOfRow({ needs_owner: STALE, needs_owner_href: null })).toEqual({ ask: STALE, refs: ['a-7693c00e', 't-40'], waits_on: { approval: 'a-7693c00e' }, legacy: true });
    expect(needsOfRow({ needs_owner: 'Allow a-11111111 and a-22222222' }).waits_on).toBeUndefined();
    expect(needsOfRow({ needs_owner: null })).toBeNull();
  });
  it('refs in words: tasks, approvals, pull requests, conversations, once each', () => {
    expect(refsIn('t-40 then sleepunit-agents/art#68, art#68, cv-9969daf1e77c and t-40 again; a-7693c00e')).toEqual(['t-40', 'sleepunit-agents/art#68', 'art#68', 'cv-9969daf1e77c', 'a-7693c00e']);
  });
});
