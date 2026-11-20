/** How long Comms keeps a message's words. The household sets it in Setup; the database holds the setting
 * and its default (household-settings.ts answers before the row exists). */
import type { DataDatabase } from './database.js';
import { householdSettings } from './household-settings.js';

/** The most a household may ask for; the column's check allows 1 to this. */
export const COMMS_DAYS_MAX = 14;

export const commsKeepDays = (db: DataDatabase): number =>
  householdSettings(db).commsDays;
