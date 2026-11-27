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
    actions: { answer: 'inbox.answer', volume: 'inbox.volume' },
  });
});

it('answers with one of the fixed answers and sets how loudly it is shown with one of the column\'s three', () => {
  const actions = catalogue().find((b) => b.name === 'question')!.actions;
  // How loudly a question is shown is one of the column's three choices, sent by inbox.volume.
  expect(actions.volume).toMatchObject({ type: 'object', required: ['volume'], additionalProperties: false, properties: { volume: { enum: ['full', 'dim', 'mute'] } } });
  expect(actions.answer).toMatchObject({ type: 'object', required: ['answer'], additionalProperties: false,
    properties: { answer: { enum: ['yes', 'no', 'words', 'done', 'dismiss'] } } });
});
