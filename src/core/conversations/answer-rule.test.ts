import { expect, it } from 'vitest';
import { acceptAnswer, answerable } from './answer-rule.js';

const question = { toKind: 'person' as const, answers: 'yes-no' as const, state: 'waiting' as const, source: 'notice' as const,
  waitsOnKind: null, answer: null, answerText: null, answeredBy: null };
const answered = { ...question, state: 'answered' as const, answer: 'yes' as const, answeredBy: 'alice' };

it('offers an answer exactly where one would be accepted', () => {
  expect(answerable(question)).toBe(true);
  expect(acceptAnswer(question, 'alice', 'yes', undefined, false)).toBe('apply');
  for (const change of [{ toKind: 'agent' as const }, { answers: null }, { state: 'resolved' as const }, { state: 'answered' as const },
    { source: 'task' as const }, { source: 'approval' as const }, { source: 'secret-request' as const }, { waitsOnKind: 'task' }]) {
    const item = { ...question, ...change };
    expect(answerable(item)).toBe(false);
    expect(() => acceptAnswer(item, 'alice', 'yes', undefined, false)).toThrow();
  }
});
it('checks the answer against the kind of question', () => {
  expect(() => acceptAnswer({ ...question, answers: 'words' }, 'alice', 'yes', undefined, false)).toThrow('needs words');
  expect(() => acceptAnswer(question, 'alice', 'words', '  ', false)).toThrow('needs words');
  expect(acceptAnswer({ ...question, answers: 'words' }, 'alice', 'words', 'Friday', false)).toBe('apply');
});
it('calls only the very same answer a repeat, and refuses a different one', () => {
  expect(acceptAnswer(answered, 'alice', 'yes', undefined, false)).toBe('repeat');
  expect(() => acceptAnswer(answered, 'alice', 'no', undefined, false)).toThrow('already answered');
  expect(() => acceptAnswer(answered, 'bob', 'yes', undefined, false)).toThrow('already answered');
  const worded = { ...question, answers: 'words' as const, state: 'answered' as const, answer: 'words' as const, answerText: 'Friday', answeredBy: 'alice' };
  expect(acceptAnswer(worded, 'alice', 'words', 'Friday', false)).toBe('repeat');
  expect(() => acceptAnswer(worded, 'alice', 'words', 'Monday', false)).toThrow('already answered');
  // Sealed words cannot be compared, so a second worded answer is never waved through.
  expect(() => acceptAnswer({ ...worded, answerText: null }, 'alice', 'words', 'Friday', true)).toThrow('already answered');
  expect(acceptAnswer(answered, 'alice', 'yes', undefined, true)).toBe('repeat');
});
