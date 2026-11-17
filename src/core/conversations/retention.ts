/** The one statement of how long a message's words are kept. Every reader, the writers that stamp a
 * limit, and the sweep that erases ask here; none of them works a deadline out for itself. */
import { COMMS_DAYS_MAX } from '../data/comms-days.js';

const DAY_MS = 86400000;
/** A keep time a household can have set: whole days, from 1 to the most Setup allows. */
export const validKeepDays = (days: number): boolean => Number.isInteger(days) && days >= 1 && days <= COMMS_DAYS_MAX;
/** The age limit alone: when something written at `at` (milliseconds) is `days` old. */
export const ageLimit = (at: number, days: number): number => at + days * DAY_MS;
/** The limit stamped on words as they are written. */
export const keepUntilFor = (at: string, days: number): string => new Date(ageLimit(Date.parse(at), days)).toISOString();
/** Anything written at or before this is past the age limit at `now`. */
export const ageCutoff = (now: string, days: number): string => new Date(Date.parse(now) - days * DAY_MS).toISOString();
/** When these words stop being kept: the earlier of the limit stamped on them and the household's
 * current age limit. Not a number (so never "later than now") when the keep time is not valid or
 * either time cannot be read. */
export function wordsDeadline(message: { keepUntil: string | null; at: string }, days: number): number {
  if (!validKeepDays(days)) return NaN;
  return Math.min(Date.parse(message.keepUntil ?? ''), ageLimit(Date.parse(message.at), days));
}
/** Whether these words are still kept at `now`. */
export const wordsKept = (message: { keepUntil: string | null; at: string }, days: number, now: string): boolean =>
  wordsDeadline(message, days) > Date.parse(now);
