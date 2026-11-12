/**
 * One Inbox card, not two (t-2098): a conversation's ask that waits on a task the owner is already asked on is that
 * task's card. Seen 2026-11-10: a task assigned to the owner with its own ask, and a wake's digest waiting on that task
 * with the same words, showed as two cards.
 */
import { describe, expect, it } from 'vitest';
import { foldTaskAsks } from './handler.js';
import { answeredAsk } from '../needs-resolve.js';
import type { HomeAsk } from './render.js';

const TASKS = 'tasks';
const task = (id: string, text = 'Can you check the hotspot?'): HomeAsk =>
  ({ text, agent: 'art', page: `task/${id}`, label: 'Open', kind: 'todo', source: { id: TASKS, base: '/p/tasks/' } }) as HomeAsk;
const digest = (on: string | undefined, agent = 'art'): HomeAsk =>
  ({ kind: 'alert', text: 'Can you check the hotspot?', page: 'loom:conversation/cv-0123456789ab', agent,
    source: { id: `agent:${agent}`, base: `/a/${agent}/` }, ...(on ? { waitsOnTask: on } : {}) }) as HomeAsk;

describe('a conversation ask waiting on a task with its own ask', () => {
  it('shows only the task\'s card', () => {
    const out = foldTaskAsks([task('t-2059'), digest('t-2059')], TASKS);
    expect(out).toHaveLength(1);
    expect(out[0].page).toBe('task/t-2059');
  });
  it('stays when the task has no card of its own, or waits on another task, or nothing', () => {
    const asks = [task('t-2059'), digest('t-2060'), digest(undefined)];
    expect(foldTaskAsks(asks, TASKS)).toEqual(asks);
    expect(foldTaskAsks([digest('t-2059')], TASKS)).toHaveLength(1);
  });
  it('folds only into the tasks piece\'s own card, never one another piece links the same way', () => {
    const lookalike = { ...task('t-2059'), source: { id: 'other', base: '/p/other/' } } as HomeAsk;
    expect(foldTaskAsks([lookalike, digest('t-2059')], TASKS)).toHaveLength(2);
    expect(foldTaskAsks([task('t-2059', '  '), digest('t-2059')], TASKS)).toHaveLength(2);
  });
  it('keeps another agent and unattributed cards separate', () => {
    const mark = digest('t-2059', 'mark');
    expect(foldTaskAsks([digest('t-2059'), task('t-2059'), mark], TASKS)).toEqual([task('t-2059'), mark]);
    const { agent: _agent, ...legacy } = task('t-2059');
    expect(foldTaskAsks([legacy, digest('t-2059')], TASKS)).toHaveLength(2);
  });
  it('fills missing why and outcome lines without replacing task values or navigation', () => {
    const ask = { ...digest('t-2059'), needs: { why: 'Digest why', if_yes: 'Digest yes', if_no: 'Digest no', answers: 'yes-no', refs: [], details: '' } } as HomeAsk;
    const own = { ...task('t-2059'), why: 'Task why', if_no: 'Task no' };
    const [kept] = foldTaskAsks([own, ask], TASKS);
    expect(kept.page).toBe(own.page);
    expect(kept.text).toBe(own.text);
    expect(kept.source).toEqual(own.source);
    expect(kept.needs).toMatchObject({ why: 'Task why', if_yes: 'Digest yes', if_no: 'Task no', answers: 'words' });
    expect(foldTaskAsks([task('t-2059'), ask], TASKS)[0].needs).toMatchObject({ why: 'Digest why', if_yes: 'Digest yes', if_no: 'Digest no' });
    expect(foldTaskAsks([{ ...own, if_yes: 'Task yes' }, ask], TASKS)[0].needs).toMatchObject({ why: 'Task why', if_yes: 'Task yes', if_no: 'Task no' });
    expect(own).not.toHaveProperty('needs');
  });
  it('folds only the same words: another question waiting on the task stays its own card', () => {
    const other = { ...digest('t-2059'), text: 'OK to buy a spare Pi while we wait?' } as HomeAsk;
    expect(foldTaskAsks([task('t-2059'), other], TASKS)).toHaveLength(2);
    const loose = { ...digest('t-2059'), text: '  can you CHECK the\nhotspot? ' } as HomeAsk;
    expect(foldTaskAsks([task('t-2059'), loose], TASKS)).toHaveLength(1);
  });
  it('the task\'s quiet card takes the ask\'s call on his attention', () => {
    const quiet = { ...task('t-2059'), attention: false } as HomeAsk;
    const [kept] = foldTaskAsks([quiet, digest('t-2059')], TASKS);
    expect(kept.page).toBe('task/t-2059');
    expect(kept.attention).toBeUndefined();
    // Quiet when the ask was quiet too, and untouched when nothing folds into it.
    expect(foldTaskAsks([quiet, { ...digest('t-2059'), attention: false } as HomeAsk], TASKS)).toEqual([quiet]);
    expect(foldTaskAsks([quiet], TASKS)).toEqual([quiet]);
  });
});

describe('the owner\'s answer on a task, as the tasks page writes it', () => {
  it('names the ask it answers', () => {
    expect(answeredAsk('Yes, to: Can you check the hotspot?\nIf yes, you said: I test it.')).toBe('Can you check the hotspot?');
    expect(answeredAsk('No, to: Can you check it?')).toBe('Can you check it?');
    expect(answeredAsk('Answer, to: Which box?\n\nThe spare.')).toBe('Which box?');
    expect(answeredAsk('Looks good to me')).toBeUndefined();
    expect(answeredAsk('a note\nYes, to: sneaky')).toBeUndefined();
  });
});
