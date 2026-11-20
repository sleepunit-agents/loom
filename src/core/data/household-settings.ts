/** The household's settings: one row, and one place that answers before the row exists.
 * The defaults are the columns' own, read from the schema, so a default changed there changes what
 * Setup shows, what the settings operation returns and what the scheduler uses for an unset household. */
import type { DataDatabase } from './database.js';
import { household } from './schema.js';

type Settings = Omit<typeof household.$inferSelect, 'singleton'>;

/** What a household has until it says otherwise. */
export const householdDefaults: Readonly<Settings> = Object.freeze({
  defaultAgent: null,
  timezone: household.timezone.default as Settings['timezone'],
  commsDays: household.commsDays.default as Settings['commsDays'],
  githubOwner: household.githubOwner.default as Settings['githubOwner'],
  secretsDefault: household.secretsDefault.default as Settings['secretsDefault'],
  backupTarget: household.backupTarget.default as Settings['backupTarget'],
  backupAt: household.backupAt.default as Settings['backupAt'],
  backupKeep: household.backupKeep.default as Settings['backupKeep'],
});
/** The most backups a household may keep; the column's check allows 1 to this. */
export const BACKUP_KEEP_MAX = 90;

/** The settings row, or the defaults when the household has not been set up. */
export function householdSettings(db: DataDatabase): Settings {
  const row = db.select().from(household).get();
  if (!row) return { ...householdDefaults };
  const { singleton: _one, ...settings } = row;
  return settings;
}

/** The zone every time a person reads is shown in, and the one schedules are kept in. */
export const householdTimezone = (db: DataDatabase): string =>
  db.query.household.findFirst({ columns: { timezone: true } }).sync()?.timezone ?? householdDefaults.timezone;
