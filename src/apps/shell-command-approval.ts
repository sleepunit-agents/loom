import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MESSAGE_WORDS_MAX } from '../core/conversations/words.js';

/** The full command is displayed as a quoted string. Escape non-ASCII code units too, so
 * invisible formatting cannot alter the way another part of the command reads. */
const display = (text: string) => JSON.stringify(text).replace(/[^\x20-\x7e]/g,
  ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));

const shellTargetPrefix = 'shell:sha256:';
const targetOf = (text: string) => shellTargetPrefix + createHash('sha256').update(text).digest('hex');
const shellInput = z.object({
  kind: z.literal('command'),
  commandText: z.string().max(MESSAGE_WORDS_MAX).refine(text =>
    !!text.trim() && !text.includes('\0') && !/\p{Surrogate}/u.test(text) && display(text).length <= MESSAGE_WORDS_MAX,
    'Supply the complete UTF-8 shell command within the card detail limit.'),
});
export const shellCommandSpend = shellInput.extend({id: z.string().min(1)}).strict().transform(
  ({kind, id, commandText}) => ({kind, id, target: targetOf(commandText), literalShell: true as const}));
export const shellCommandRequest = shellInput.extend({
  why: z.string().trim().min(1).max(2000),
  minutes: z.number().int().min(1).max(1440).optional(),
}).strict().transform(({ commandText, ...request }) => {
  const details = display(commandText);
  const preview = details.length <= 180 ? details : details.slice(0, 180) + '… (shortened, open Full command)';
  // Shell dialects, comments and quoting determine how punctuation is interpreted.
  // Say exactly which characters are present, including when they occur in a quoted argument.
  const marks = [...new Set(commandText.replace(/[\r\n]+$/, '').match(/[;&|\n]/g))];
  const syntax = marks.map(mark => mark === '\n' ? 'a line break' : '`' + mark + '`').join(', ');
  return {
    ...request, literalShell: true as const, details, target: targetOf(commandText),
    what: 'Run shell command ' + preview,
    ask: 'Allow this shell command? ' + preview + (syntax ? ' Check for command chaining. The text contains ' + syntax + '.' : ''),
    ifYes: 'Allow one use of this exact command.', ifNo: 'Decline this command.',
  };
});
