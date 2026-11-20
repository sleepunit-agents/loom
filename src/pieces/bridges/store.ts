import type { Db } from '../../core/index.js';
import type { Venue, Route, PersonLink } from './model.js';
export type Records = { venues: Venue; routes: Route; links: PersonLink };
export function all<K extends keyof Records>(db: Db, table: K): Records[K][] {
  return (db.prepare(`SELECT record FROM bridges_${table} ORDER BY id`).all() as {record: string}[]).map(r => JSON.parse(r.record) as Records[K]);
}
export function put<K extends keyof Records>(db: Db, table: K, record: Records[K]) {
  bumpSetup(db);
  db.prepare(`INSERT INTO bridges_${table}(id,record) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record`).run(record.id, JSON.stringify(record));
}
export const venueById = (db: Db, id: string) => all(db, 'venues').find(v => v.id === id);
export function routeFor(db: Db, venue: Venue, channel: string, parent?: string): Route | undefined {
  const routes = all(db, 'routes').filter(r => r.platform === venue.platform && r.workspace === venue.workspace);
  return routes.find(r => r.channel === channel) ?? routes.find(r => r.channel === parent);
}
/** Ambiguity fails closed, including before an importer can write a unique link. */
export function personFor(db: Db, venue: Venue, user: string): string | undefined {
  const links = all(db, 'links').filter(l => l.platform === venue.platform && l.workspace === venue.workspace && l.user === user);
  return links.length === 1 ? links[0].person : undefined;
}

/** Transactional setup epoch invalidates even edits restored during an await. */
export function bumpSetup(db: Db) {
  db.prepare("INSERT INTO bridges_meta VALUES ('setup-revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
}
export function setupRevision(db: Db): string {
  return (db.prepare("SELECT value FROM bridges_meta WHERE key='setup-revision'").get() as {value:string} | undefined)?.value ?? '0';
}
