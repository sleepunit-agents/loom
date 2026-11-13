/** Explicit offline import. Projects come only from the destination household. */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { acquireHttpLock } from '../transport/http-lock.js';
import { createFoundation } from '../core/app.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { SharingDatabase } from '../core/household/sharing.js';
import { importChanges } from '../pieces/changes/importer.js';
import type { IOStreams } from './io.js';
const attributionSchema = z.object({
  agents: z.record(z.string().min(1), z.object({ logins: z.array(z.string().min(1)), branches: z.array(z.string().min(1)) }).strict()),
  ownerLogins: z.array(z.string().min(1)),
  taskOwner: z.string().min(1).optional(),
}).strict();
const usage = 'usage: loom migrate changes --from <snapshot.json> --attribution <map.json> [--home <stopped-home>]\n';
export async function migrateChanges(argv: string[], io: IOStreams): Promise<number> {
  let args;
  try { args = parseArgs({ args: argv, options: { from: { type: 'string' }, home: { type: 'string' }, attribution: { type: 'string' } }, strict: true, allowPositionals: false }); }
  catch { io.stderr(`Invalid Changes import arguments.\n${usage}`); return 2; }
  if (!args.values.from || !args.values.attribution) { io.stderr(usage); return 2; }
  const home = args.values.home ?? io.env.LOOM_HOME ?? join(homedir(), '.config', 'loom');
  let release: (() => void) | undefined;
  try {
    release = acquireHttpLock(home);
    const attribution = attributionSchema.parse(JSON.parse(await readFile(args.values.attribution, 'utf8')));
    const app = createFoundation({ home });
    try {
      const result = app.db.transaction(() => {
        const household = new HouseholdDatabase(app.db).household(home);
        if (!household) throw new Error('Import the household before Changes');
        if (Object.keys(attribution.agents).some(id => !household.agents.includes(id)) || (attribution.taskOwner && !household.agents.includes(attribution.taskOwner) && !household.members.some(member => member.person === attribution.taskOwner))) throw new Error('Attribution names an unknown household agent or task owner');
        const sharing = new SharingDatabase(app.db, home);
        const projects = sharing.projectIds().map(id => {
          const project = sharing.project(id)!;
          return { slug: project.slug, name: project.name, repos: project.repositories };
        });
        return importChanges(app.db, args.values.from!, { projects, attribution });
      })();
      io.stdout(JSON.stringify(result, null, 2) + '\n'); return 0;
    } finally { app.close(); }
  } catch { io.stderr('Changes import refused; verify snapshot, attribution and imported household, and stop the destination daemon.\n'); return 1; }
  finally { release?.(); }
}
