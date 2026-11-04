// @vitest-environment node
/**
 * Answering a Needs you in its sheet (web/src/inbox.tsx, web/src/drafts.ts): Yes and No for a yes/no question, words
 * below them, and nothing typed lost (Jonathan, 2026-11-04: he typed an answer, pressed Done, and it never went).
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import { AnswerBox } from '../../web/src/inbox';
import { draftOf, guardFooter, hasDraft, keepDraft } from '../../web/src/drafts';
import { answersOf, parseNeeds, yesNoText, type NeedsOwner } from '../backends/needs.js';

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };
const ACTIONS = [{ action: 'needs-done', label: 'Done' }, { action: 'needs-dismiss', label: 'Dismiss' }];
const answer = (o: Partial<{ draft: string; busy: boolean }> = {}) => {
  const draft = o.draft ?? '';
  return { draft, setDraft: () => {}, drafted: !!draft.trim(), busy: !!o.busy, reply: async () => {}, say: async () => {}, label: 'Reply to Art E Fish' };
};

describe('the draft guard', () => {
  it('with nothing typed, Done and Dismiss are themselves', () => {
    expect(guardFooter(ACTIONS, false, false)).toEqual([{ b: ACTIONS[0], send: false, disabled: false }, { b: ACTIONS[1], send: false, disabled: false }]);
  });
  it('with words in the box, Done is "Send and mark done" (it sends them), and Dismiss waits for them', () => {
    expect(guardFooter(ACTIONS, true, false)).toEqual([{ b: ACTIONS[0], send: true, label: 'Send and mark done', disabled: false }, { b: ACTIONS[1], send: false, disabled: true }]);
  });
  it('while anything is sending, every answer waits (a Done mid-send answered the ask first, 2026-11-04)', () => {
    expect(guardFooter(ACTIONS, false, true).every((f) => f.disabled)).toBe(true);
    expect(guardFooter(ACTIONS, true, true)[0]).toMatchObject({ send: true, label: 'Sending…', disabled: true });
  });
  it('another item\'s buttons are untouched', () => {
    const ratify = [{ action: 'ratify', label: 'Ratify' }];
    expect(guardFooter(ratify, false, false)).toEqual([{ b: ratify[0], send: false, disabled: false }]);
  });
});

describe('drafts, kept on this device per item', () => {
  it('a draft is kept by its item, read back, and blank drops it', () => {
    const s = store();
    keepDraft('k1', 'yes, merge it', s);
    expect(draftOf('k1', s)).toBe('yes, merge it');
    expect(hasDraft('k1', s)).toBe(true);
    expect(hasDraft('k2', s)).toBe(false);
    keepDraft('k1', '  ', s);
    expect(s.m.size).toBe(0);
  });
  it('storage that throws keeps nothing, and breaks nothing', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('denied'); } };
    expect(() => keepDraft('k', 'x', bad)).not.toThrow();
    expect(draftOf('k', bad)).toBe('');
  });
});

describe('the answer box', () => {
  it('a yes/no question: Yes and No first, then "Or answer in your own words"', () => {
    const html = renderToStaticMarkup(h(AnswerBox, { a: answer(), yesNo: true }));
    expect(html.indexOf('>Yes<')).toBeGreaterThan(-1);
    expect(html.indexOf('>No<')).toBeGreaterThan(html.indexOf('>Yes<'));
    expect(html.indexOf('Or answer in your own words')).toBeGreaterThan(html.indexOf('>No<'));
  });
  it('a words-only ask has no Yes or No: its box is "Reply to <agent>"', () => {
    const html = renderToStaticMarkup(h(AnswerBox, { a: answer(), yesNo: false }));
    expect(html).not.toContain('>Yes<');
    expect(html).toContain('Reply to Art E Fish');
  });
  it('a draft says it isn\'t sent yet', () => {
    expect(renderToStaticMarkup(h(AnswerBox, { a: answer({ draft: 'yes' }), yesNo: true }))).toContain('Not sent yet');
    expect(renderToStaticMarkup(h(AnswerBox, { a: answer(), yesNo: true }))).not.toContain('Not sent yet');
  });
});

describe('answers, as the agent writes them', () => {
  const ask = (o: Record<string, unknown>) => parseNeeds({ ask: 'OK to merge the fix?', ...o }, undefined) as NeedsOwner;
  it('an ask with if_yes or if_no is a yes/no question; one without is words; answers says so outright', () => {
    expect(answersOf(ask({ if_yes: 'I close it.' }))).toBe('yes-no');
    expect(answersOf(ask({}))).toBe('words');
    expect(answersOf(ask({ answers: 'yes-no' }))).toBe('yes-no');
    expect(answersOf(ask({ if_yes: 'Say who.', answers: 'words' }))).toBe('words');
    expect(parseNeeds({ ask: 'x?', answers: 'maybe' }, undefined)).toMatch(/needs_owner.answers is "yes-no"/);
  });
  it('a Yes or a No is sent as the answer, the ask, and its own line', () => {
    const n = ask({ if_yes: 'I close it.', if_no: 'It stays open.' });
    expect(yesNoText(n, 'yes')).toBe('Yes, to: OK to merge the fix?\nIf yes, you said: I close it.');
    expect(yesNoText(ask({ answers: 'yes-no' }), 'no')).toBe('No, to: OK to merge the fix?');
  });
});
