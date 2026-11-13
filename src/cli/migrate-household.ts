import { realpathSync } from 'node:fs';
import { dirname, resolve, basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { acquireHttpLock } from '../transport/http-lock.js';
import { createFoundation } from '../core/app.js';
import { importHousehold } from '../pieces/household/importer.js';
import type { IOStreams } from './io.js';
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return join(canonicalPath(dirname(absolute)), basename(absolute));
  }
}
export async function migrateHousehold(argv: string[], io: IOStreams): Promise<number> {
  let args;
  try { args = parseArgs({ args: argv, options: { from: { type: 'string' }, home: { type: 'string' } }, strict: true }); }
  catch (e) { io.stderr(`${(e as Error).message}\n`); return 2; }
  if (!args.values.from || !args.values.home) { io.stderr('usage: loom migrate household --home <new-home> --from <stopped-old-home>\n'); return 2; }
  let release: (() => void) | undefined;
  try {
    const target = canonicalPath(args.values.home), source = realpathSync(args.values.from);
    if (target === source || target.startsWith(source + '/')) throw new Error('Household import requires a different destination home');
    release = acquireHttpLock(args.values.home);
    const app = createFoundation({ home: args.values.home });
    try { io.stdout(JSON.stringify(importHousehold(app.db, args.values.home, args.values.from, Date.now()), null, 2) + '\n'); return 0; }
    finally { app.close(); }
  } catch (e) { io.stderr(`household import refused: ${(e as Error).message}\n`); return 1; }
  finally { release?.(); }
}
