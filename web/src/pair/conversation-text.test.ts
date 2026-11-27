import { expect, it } from 'vitest';
import { conversationText } from './conversation-text';

const envelope = '[Loom context · t-2 · decision]\n';
// The words the removed context prototype stored, kept here as it wrote them: threads still hold such messages.
const draft = { title: '', goal: '', why: '', doneWhen: '' };
const splitPrompt = (request: string, id: string, parent: string) =>
  'Prepare a split proposal ' + id + ' for ' + parent + '. Read the ticket and its related work. Return just JSON ' +
  JSON.stringify({ proposal: id, drafts: [draft, draft] }) +
  '. Fill the two drafts with concrete independent outcomes. This is a preview only. Leave all tickets untouched.\nRequest: ' + request;
const reviewRequest = (id: string, latest: number) =>
  'Review the decision evidence for ' + id + ' through note ' + latest + '. Read the current ticket and comments in Loom. ' +
  'Identify the unresolved decision and up to three distinct findings that bear on it, including evidence that supersedes older claims. ' +
  'For each finding, quote one exact continuous passage from a numbered ticket comment. Return JSON only in this shape: ' +
  '{"ticket":"' + id + '","through":' + latest + ',"question":"...","findings":[{"seq":1,"quote":"..."}]}. ' +
  'Keep this a read-only review.';

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
