import { migrate, type Db } from '../db/index.js';

/** Inert until the household importer commits its cutover marker. */
export function migrateHouseholdTables(db: Db): void {
  migrate(db, 'household', [{ number: 1, sql: `
    CREATE TABLE household_settings (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_agents (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_members (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_projects (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_tokens (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_token_use (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_links (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_challenges (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_passkeys (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_push (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_readers (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_piece_settings (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE TABLE household_imports (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
  ` }]);
}
