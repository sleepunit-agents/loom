import { expect, it } from 'vitest';
import { readSplit, splitFor, splitPrompt } from './split';
import type { CommsMessage } from '../pieces/comms-view/model';
it('attaches fenced drafts with surrounding prose only to their originating subject and proposal', () => {
  const draft = { title: 'Verify', why: 'Trust', goal: 'Check', doneWhen: 'Matches' };
  const json = JSON.stringify({ proposal: 'first', drafts: [draft, draft] });
  const reply = 'Two independent checks.\n\n\x60\x60\x60json\n' + json + '\n\x60\x60\x60\n';
  const messages = [
    {
      seq: 7,
      kind: 'message',
      words: '[Loom context · t-2 · entity/ticket/t-2]\n' + splitPrompt('split this', 'first', 't-2'),
    },
    { seq: 8, kind: 'reply', sender: 'art', words: reply },
  ] as CommsMessage[];
  expect(splitFor(messages, 'entity/ticket/t-2', 'art')?.drafts).toEqual([draft, draft]);
  expect(splitFor(messages, 'entity/ticket/t-3', 'art')).toBeUndefined();
  expect(splitFor(messages, 'entity/ticket/t-2', 'someone')?.drafts).toBeUndefined();
  expect(readSplit(reply + reply)).toBeUndefined();
});
