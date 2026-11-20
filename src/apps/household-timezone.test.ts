/** The household's row has one first timezone, whichever write makes the row. */
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createDataSchema } from '../core/data/database.js';
import { household } from '../core/data/schema.js';
import { householdService } from './household.js';

afterEach(() => { vi.restoreAllMocks(); });
it.each(['initialize', 'setSettings', 'setSecretsDefault'] as const)('seeds the server\'s zone when %s makes the row, and never replaces a stored choice', first => {
  const actual = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) { return { ...actual.call(this), timeZone: 'Pacific/Auckland' }; });
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client), service = householdService(db, () => '2026-11-17T00:00:00.000Z');
    if (first === 'initialize') service.initialize();
    else if (first === 'setSettings') service.setSettings({ backupKeep: 3 });
    else service.setSecretsDefault(household.secretsDefault.enumValues[0]);
    expect(db.select().from(household).all()).toMatchObject([{ timezone: 'Pacific/Auckland' }]);
    // A choice the household made is kept by every later write.
    service.setSettings({ timezone: 'Europe/Lisbon' });
    service.initialize(); service.setSecretsDefault(household.secretsDefault.enumValues[1]); service.setSettings({ backupKeep: 5 });
    expect(db.select().from(household).all()).toMatchObject([{ timezone: 'Europe/Lisbon', backupKeep: 5, secretsDefault: household.secretsDefault.enumValues[1] }]);
  } finally { client.close(); }
});
