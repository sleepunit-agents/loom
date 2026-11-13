import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { acquireHttpLock } from '../transport/http-lock.js';
import { createFoundation } from '../core/app.js';
import { importAttention } from '../pieces/attention/importer.js';
import type { ImportScopes } from '../pieces/attention/importer.js';
import type { IOStreams } from './io.js';
export async function migrateAttention(argv: string[], io: IOStreams): Promise<number> {
  let args;
  try { args = parseArgs({ args: argv, options: { from: { type: 'string', multiple: true }, home: { type: 'string' }, scopes: { type: 'string' } }, strict: true, allowPositionals: false }); }
  catch (e) { io.stderr(`${(e as Error).message}\n`); return 2; }
  if (!args.values.from?.length || !args.values.home || !args.values.scopes) {
    io.stderr('usage: loom migrate attention --home <stopped-new-home> --from <copied-memories.db> [--from <another-copy.db>] --scopes <conversation-audiences.json>\n'); return 2;
  }
  let release: (() => void) | undefined;
  try {
    release = acquireHttpLock(args.values.home);
    const scopes = JSON.parse(await readFile(args.values.scopes,'utf8')) as ImportScopes;
    const app = createFoundation({ home: args.values.home });
    try { io.stdout(JSON.stringify(importAttention(app.db,args.values.from,scopes),null,2) + '\n'); return 0; }
    finally { app.close(); }
  } catch (e) { io.stderr(`attention import refused: ${(e as Error).message}\n`); return 1; }
  finally { release?.(); }
}
