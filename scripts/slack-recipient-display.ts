// Opt exact directory matches in or out of owner-facing access card display.
// Rows in the private JSON file are [workspace, account, person slug]. Report counts only.
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {sightingHolder} from '../src/backends/people-accounts.js';

const [directory, path, action, mode, ...extra] = process.argv.slice(2);
if (!directory || !path || !['enable','disable'].includes(action ?? '') ||
    (mode !== undefined && mode !== '--apply') || extra.length) {
  throw Error('Expected DIRECTORY_DB MATCHES_JSON enable|disable [--apply]');
}
const field = z.string().min(1);
const rows = z.array(z.tuple([field,field,field])).min(1).parse(JSON.parse(readFileSync(path,'utf8')));
const apply = mode === '--apply';
const db = new Database(directory, {fileMustExist:true, readonly:!apply});
try {
  const update = db.transaction(() => {
    const previous = db.prepare('SELECT slug,recipient_display_slug AS enabled FROM person_sighting_aliases WHERE workspace=? AND account=?');
    const write = apply ? db.prepare('UPDATE person_sighting_aliases SET recipient_display_slug=? WHERE workspace=? AND account=? AND slug=?') : undefined;
    const seen = new Set<string>();
    let changed = 0;
    for (const [workspace,account,slug] of rows) {
      const key = JSON.stringify([workspace,account]);
      if (seen.has(key)) throw Error('An account is listed more than once');
      seen.add(key);
      const row = previous.get(workspace,account) as {slug:string;enabled:string|null}|undefined;
      if (row?.slug !== slug || (action === 'enable' && sightingHolder(db,'slack',workspace,account) !== slug)) {
        throw Error('A reviewed match has changed');
      }
      const next = action === 'enable' ? slug : null;
      if (row.enabled === next) continue;
      write?.run(next,workspace,account,slug);
      changed++;
    }
    return {accounts:rows.length, changed, applied:apply};
  });
  console.log(JSON.stringify(apply ? update.immediate() : update()));
} finally { db.close(); }
