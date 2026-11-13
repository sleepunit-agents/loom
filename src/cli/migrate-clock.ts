import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { acquireHttpLock } from '../transport/http-lock.js';
import { createFoundation } from '../core/app.js';
import { importClock } from '../pieces/clock/importer.js';
import type { IOStreams } from './io.js';
export async function migrateClock(argv: string[], io: IOStreams): Promise<number> {
  let args;
  try { args = parseArgs({ args: argv, options: { from: { type: 'string' }, home: { type: 'string' } }, strict: true }); }
  catch (e) { io.stderr(`${(e as Error).message}\n`); return 2; }
  if (!args.values.from) { io.stderr('usage: loom migrate clock --from <old-WAKE_DATA-directory> [--home <stopped-home>]\n'); return 2; }
  const home = args.values.home ?? io.env.LOOM_HOME ?? join(homedir(), '.config', 'loom');
  // The daemon's existing single-home socket is the exclusive stopped-daemon gate.
  let release: (() => void) | undefined;
  try {
    release = acquireHttpLock(home);
    const app = createFoundation({ home });
    try { io.stdout(JSON.stringify(importClock(app.db, args.values.from, Date.now()), null, 2) + '\n'); return 0; }
    finally { app.close(); }
  } catch (e) { io.stderr(`clock import refused: ${(e as Error).message}\n`); return 1; }
  finally { release?.(); }
}
