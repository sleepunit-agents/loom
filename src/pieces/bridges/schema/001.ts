import type { Migration } from '../../../core/index.js';
export const schema: Migration[] = [{ number: 1, sql: `
CREATE TABLE bridges_venues (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE bridges_routes (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE UNIQUE INDEX bridges_route_place ON bridges_routes(json_extract(record,'$.platform'),json_extract(record,'$.workspace'),json_extract(record,'$.channel'));
CREATE TABLE bridges_links (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE UNIQUE INDEX bridges_link_user ON bridges_links(json_extract(record,'$.platform'),json_extract(record,'$.workspace'),json_extract(record,'$.user'));
CREATE TABLE bridges_inbox (id TEXT PRIMARY KEY, venue TEXT NOT NULL, message TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, received INTEGER NOT NULL, delivered INTEGER);
CREATE TABLE bridges_conversations (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE bridges_outbox (id TEXT PRIMARY KEY, incoming TEXT NOT NULL, venue TEXT NOT NULL, address TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, remote_id TEXT, created INTEGER NOT NULL);
CREATE TABLE bridges_status (id TEXT PRIMARY KEY, state TEXT NOT NULL, changed INTEGER NOT NULL);
CREATE TABLE bridges_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
` }];
