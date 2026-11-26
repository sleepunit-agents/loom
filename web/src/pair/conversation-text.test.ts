import { expect, it } from 'vitest';
import { splitPrompt } from '../contexts/split';
import { reviewRequest } from '../contexts/evidence';
import { conversationText } from './conversation-text';

const envelope = '[Loom context · t-2 · decision]\n';

it('shows the request inside stored context commands', () => {
  const request = 'Show "history". Current modules: all?\nThanks.';
  expect(conversationText('message', envelope + splitPrompt(request, 'one', 't-2'))).toBe(request);
  expect(conversationText('message', envelope + 'Interpret this workspace request: ' +
    JSON.stringify(request) + '. Current modules: goal')).toBe(request);
  expect(conversationText('message', envelope + reviewRequest('t-2', 2))).toBe('Review the decision evidence for t-2.');
  expect(conversationText('message', '[Ticket workspace · t-2]\n' + request)).toBe(request);
});

it('formats a Loom layout response and preserves surrounding prose and ordinary JSON', () => {
  const proposal = '{"view":"task","add":["history"],"remove":[]}';
  const sample = '{"add":[1],"remove":[2]}';
  expect(conversationText('reply', 'Ready.\n\n```json\n' + proposal + '\n```')).toBe('Ready.\n\nAdd history');
  expect(conversationText('reply', sample)).toBe(sample);
  expect(conversationText('message', envelope + proposal)).toBe(proposal);
});
