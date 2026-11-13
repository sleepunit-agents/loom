import type { Migration } from '../../../core/index.js';
/** Offline importer receipt. No runtime operation depends on an import having run. */
export const importSchema: Migration = { number: 5, sql: 'CREATE TABLE attention_import (id TEXT PRIMARY KEY, checksum TEXT NOT NULL);' };
