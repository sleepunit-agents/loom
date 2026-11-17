/** The one rule for answering a question in the Inbox. A question has three
 * stores (plain Inbox words, a Comms thread message, sealed Inbox words) and
 * each has its own service to write the answer; whether an answer is accepted
 * is decided here for all three, and for the "can answer" a reader is shown.
 * Why the answer is kept in more than one record is in
 * docs/accepted-tradeoffs.md ("An answer is kept in up to three records"). */
import type { inbox } from '../data/schema.js';

type Item = typeof inbox.$inferSelect;
export type Answer = NonNullable<Item['answer']>;
type Question = Pick<Item, 'toKind' | 'answers' | 'state' | 'source' | 'waitsOnKind' | 'answer' | 'answerText' | 'answeredBy'>;

/** Tasks, approvals and secret requests are answered where they live; so is
 * any question that waits on one. Their outcome settles the Inbox item. */
const linked = (item: Pick<Item, 'source' | 'waitsOnKind'>): boolean =>
  item.source === 'task' || item.source === 'approval' || item.source === 'secret-request' || !!item.waitsOnKind;

/** A question a person can still answer in the Inbox. Who that person is
 * belongs to the caller: this says nothing about the reader. */
export const answerable = (item: Pick<Item, 'toKind' | 'answers' | 'state' | 'source' | 'waitsOnKind'>): boolean =>
  item.toKind === 'person' && !!item.answers && item.state === 'waiting' && !linked(item);

/** Decide one answer attempt. 'apply' means record it. 'repeat' means this
 * exact answer is already the record, so there is nothing to write and saying
 * "saved" is true. Anything else throws: in particular a different answer to
 * an answered question, which must never be reported as saved.
 * `sealed` says the stored words cannot be compared, so a worded answer to an
 * answered question is refused; an honest retry replays its operation receipt
 * and never reaches here. */
export function acceptAnswer(item: Question, member: string, answer: Answer, words: string | undefined, sealed: boolean): 'apply' | 'repeat' {
  if (item.toKind !== 'person' || !item.answers) throw new Error('Item is not a question for a person');
  if (linked(item)) throw new Error('Answer at the linked source');
  // `done` and `dismiss` are open to every question on purpose: the Inbox offers "Mark done" and "Dismiss"
  // beside the answer, for a question that was settled some other way or that the person will not answer.
  // The question is closed and its agent is told which of the two it was.
  if ((answer === 'yes' || answer === 'no') && item.answers !== 'yes-no') throw new Error('Question needs words');
  if ((answer === 'words' || answer === 'replied') && !words?.trim()) throw new Error('Answer needs words');
  if (item.state === 'answered') {
    const sameWords = sealed ? !words?.trim() : (item.answerText ?? null) === (words ?? null);
    if (item.answer === answer && item.answeredBy === member && sameWords) return 'repeat';
    throw new Error('Question is already answered');
  }
  if (item.state !== 'waiting') throw new Error('Question is already settled');
  return 'apply';
}
