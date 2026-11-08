/**
 * loom update-identity — list sections or replace/append section body.
 */
import { parseArgs } from 'node:util';
import { listSections, updateIdentity } from '../tools/update-identity.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { readBody, renderJson } from './io.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage:
  loom update-identity <file>                  # list sections (read-only)
  loom update-identity <file> <section>        # replace section body
  loom update-identity <file> <section> --append  # add as new section

<file> is "preferences" or "self-model". IDENTITY.md is immutable.

Body (for replace/append) is read from stdin or \$EDITOR.

Options:
  --append               Add a new H2 section at end instead of replacing
  --json                 Emit {file, section, mode} on success
  --context-dir <path>   Agent context dir
  --help, -h             Show this help
`;

const EDITABLE = new Set(['preferences', 'self-model']);

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        append: { type: 'boolean' },
        help:   { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const file = parsed.positionals[0];
  const section = parsed.positionals[1];
  if (!file) { io.stderr(`Missing <file>.\n${USAGE}`); return 2; }
  if (!EDITABLE.has(file)) {
    io.stderr(`Unknown file "${file}". Editable: preferences, self-model.\n`);
    return 2;
  }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  if (!section) {
    const text = await listSections(env.contextDir, file);
    io.stdout(text.endsWith('\n') ? text : text + '\n');
    return 0;
  }

  let body: string;
  try {
    body = await readBody(io, 'update-identity');
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }
  if (!body) { io.stderr(`body cannot be empty\n`); return 2; }

  const mode = parsed.values.append ? 'append' : 'replace';
  await updateIdentity(env.contextDir, { file, section, content: body, mode });

  if (env.json) { renderJson(io, { file, section, mode }); return 0; }
  io.stdout(`${mode === 'append' ? 'Appended' : 'Replaced'} ${file}:${section}\n`);
  return 0;
}
