/** How long Comms keeps a message's words. The household sets it in Setup; the database holds the setting
 * and its default, and this is the one place that reads it. */
import type { DataDatabase } from './database.js';
import { household } from './schema.js';

/** What a household keeps until it says otherwise. The `household.comms_days` column has the same default,
 * so this answers only before the household row exists. */
export const COMMS_DAYS_DEFAULT = 14;
/** The most a household may ask for; the column's check allows 1 to this. */
export const COMMS_DAYS_MAX = 14;

export const commsKeepDays = (db: DataDatabase): number =>
  db.select({ days: household.commsDays }).from(household).get()?.days ?? COMMS_DAYS_DEFAULT;
