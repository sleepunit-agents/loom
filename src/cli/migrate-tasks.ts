import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { acquireHttpLock } from '../transport/http-lock.js';
import { createFoundation } from '../core/app.js';
import { importTasks } from '../pieces/tasks/importer.js';
import type { IOStreams } from './io.js';
export async function migrateTasks(argv: string[], io: IOStreams): Promise<number> {
  let args;
  try { args = parseArgs({ args: argv, options: { from: { type: 'string' }, home: { type: 'string' }, projects: { type: 'string' }, agent: { type: 'string' } }, strict: true }); }
  catch (e) { io.stderr(`${(e as Error).message}\n`); return 2; }
  if (!args.values.from) { io.stderr('usage: loom migrate tasks --from <store.db> [--home <stopped-home>] [--projects <epic-to-project.json>] [--agent <name>]\n'); return 2; }
  const home = args.values.home ?? io.env.LOOM_HOME ?? join(homedir(), '.config', 'loom');
  // The daemon's existing single-home socket is the exclusive stopped-daemon gate.
  let release: (() => void) | undefined;
  try {
    release = acquireHttpLock(home);
    const projects = args.values.projects ? JSON.parse(await readFile(args.values.projects, 'utf8')) as Record<string, string> : undefined;
    if (projects !== undefined && (!projects || typeof projects !== 'object' || Array.isArray(projects))) throw new Error('Project map must be an object of epic ids to project slugs');
    const app = createFoundation({ home });
    try { io.stdout(JSON.stringify(importTasks(app.db, args.values.from, Date.now(), { projects, agent: args.values.agent }), null, 2) + '\n'); return 0; }
    finally { app.close(); }
  } catch (e) { io.stderr(`tasks import refused: ${(e as Error).message}\n`); return 1; }
  finally { release?.(); }
}
