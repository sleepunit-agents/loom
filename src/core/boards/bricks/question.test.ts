/** The `question` brick's definition (./question.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { pins } from './bench.test.helper.js';
import definition from './question.js';

it('question: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: false,
    flags: [],
    linkKey: 'item',
    references: { item: 'inbox item' },
    actions: { answer: 'inbox.answer', volume: 'inbox.volume', discuss: 'inbox.discuss', taskAnswer: 'tasks.command', join: 'runtime.workerJoinDecide' },
  });
});

it('answers with one of the fixed answers and sets how loudly it is shown with one of the column\'s three', () => {
  const actions = catalogue().find((b) => b.name === 'question')!.actions;
  // How loudly a question is shown is one of the column's three choices, sent by inbox.volume.
  expect(actions.volume).toMatchObject({ type: 'object', required: ['volume'], additionalProperties: false, properties: { volume: { enum: ['full', 'dim', 'mute'] } } });
  expect(actions.answer).toMatchObject({ type: 'object', required: ['answer'], additionalProperties: false,
    properties: { answer: { enum: ['yes', 'no', 'words', 'done', 'dismiss'] } } });
});

it('tells a discussion with nothing, a task\'s answer as yes, no or words, and a machine\'s admission as allow or block', () => {
  const { discuss, taskAnswer, join } = definition.actions;
  expect(discuss.detail.safeParse({}).success).toBe(true);
  for (const detail of [{ agent: 'art' }, { thread: 'th:1' }]) expect(discuss.detail.safeParse(detail).success).toBe(false);
  for (const answer of ['yes', 'no', 'words']) expect(taskAnswer.detail.safeParse({ answer }).success, answer).toBe(true);
  // A task's question is closed in its task: it takes no Mark done and no Dismiss, and never the words.
  for (const detail of [{}, { answer: 'done' }, { answer: 'dismiss' }, { answer: 'words', text: 'typed' }, { answer: 'Use the blue one' }]) expect(taskAnswer.detail.safeParse(detail).success, JSON.stringify(detail)).toBe(false);
  for (const decision of ['allow', 'block']) expect(join.detail.safeParse({ decision }).success, decision).toBe(true);
  for (const detail of [{}, { decision: 'maybe' }, { decision: 'allow', code: 'ABCD-EFGH' }, { decision: 'allow', request: 'x' }]) expect(join.detail.safeParse(detail).success, JSON.stringify(detail)).toBe(false);
});
