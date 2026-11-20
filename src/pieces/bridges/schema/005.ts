import type { Migration } from '../../../core/index.js';
/** Private attachment data; no live record or public operation exposes these tables. */
export const schema: Migration[] = [{ number: 5, sql: `
CREATE TABLE bridges_files (
  scope TEXT NOT NULL, file TEXT NOT NULL, name TEXT NOT NULL,
  bytes BLOB NOT NULL, digest TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY(scope,file)
);
CREATE INDEX bridges_files_expiry ON bridges_files(created);
CREATE TABLE bridges_file_deliveries (
  scope TEXT NOT NULL, delivery TEXT NOT NULL, manifest TEXT NOT NULL,
  created INTEGER NOT NULL, PRIMARY KEY(scope,delivery)
);
CREATE TABLE bridges_file_sources (
  scope TEXT NOT NULL, delivery TEXT NOT NULL, file TEXT NOT NULL,
  PRIMARY KEY(scope,delivery,file),
  FOREIGN KEY(scope,file) REFERENCES bridges_files(scope,file) ON DELETE CASCADE,
  FOREIGN KEY(scope,delivery) REFERENCES bridges_file_deliveries(scope,delivery) ON DELETE CASCADE
);
` }];
