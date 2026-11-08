/**
 * loom note — an agent's notes (src/notes.ts): write, read, list, attach a file, pin, and sweep the expired.
 */
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { assertStackVersionCompatible } from '../config.js';
import { citedPaths, LIFESPANS, NoteError, Notes, type Lifespan } from '../notes.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { readStdin, renderJson } from './io.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom note <subcommand> [options]

An agent's notes: what it holds on to for a while, and some words about it. Each has a lifespan:
keep (never expires), while (60 days after its last change), short (14 days). A sweep lets the
expired go, except the ones a live memory or knowledge page cites, and the pinned.

Subcommands:
  write <path> [--lifespan keep|while|short] [--body <text>]   Write a note, whole (the text from stdin
                                                               without --body). A new note needs --lifespan
  read <path>                       The note's text (--json: with its lifespan, files, expiry)
  list [<prefix>] [--limit <n>]     Notes under a prefix (planning/), newest first
  attach <path> <file> [--name <n>] [--type <mime>]   Attach a file to a note (stored once, by its bytes)
  file <path> <name>                A note's file's bytes, to stdout
  pin <path> | unpin <path>         A pinned note never expires
  delete <path>
  sweep [--dry-run] [--cited <file>]   Let the expired go. --cited adds paths other stores cite (one a line;
                                       - for stdin), e.g. open tasks

Options: --json, and the global --context-dir (whose notes).`;

const SUBS = new Set(['write', 'read', 'list', 'attach', 'file', 'pin', 'unpin', 'delete', 'sweep']);

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  const sub = rest[0];
  if (!sub || sub === '--help' || sub === '-h') { io.stdout(USAGE); return sub ? 0 : 2; }
  if (!SUBS.has(sub)) { io.stderr(`Unknown note subcommand: ${sub}\n${USAGE}`); return 2; }
  let parsed;
  try {
    parsed = parseArgs({ args: rest.slice(1), allowPositionals: true, options: {
      lifespan: { type: 'string' }, body: { type: 'string' }, limit: { type: 'string' }, name: { type: 'string' },
      type: { type: 'string' }, 'dry-run': { type: 'boolean' }, cited: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
  } catch (err) { io.stderr(`${(err as Error).message}\n${USAGE}`); return 2; }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }
  const [a, b] = parsed.positionals;
  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); } catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }
  const by = io.env.LOOM_NOTE_BY || env.client || 'cli';
  const need = (x: string | undefined, what: string) => { if (!x) throw new NoteError(`note ${sub} needs ${what}\n${USAGE}`, 2); return x; };
  const notes = new Notes(env.contextDir);
  try {
    switch (sub) {
      case 'write': {
        const lifespan = parsed.values.lifespan;
        if (lifespan !== undefined && !LIFESPANS.has(lifespan)) throw new NoteError('--lifespan is keep, while or short', 2);
        const body = parsed.values.body ?? (io.stdinIsTTY ? undefined : await readStdin(io.stdin));
        if (body === undefined) throw new NoteError('note write takes the text from --body or stdin', 2);
        const r = notes.write(need(a, 'a path'), body, { by, ...(lifespan ? { lifespan: lifespan as Lifespan } : {}) });
        if (env.json) renderJson(io, r); else io.stdout(`${r.path} (${r.lifespan}${r.expires ? `, until ${r.expires.slice(0, 10)}` : ''})\n`);
        return 0;
      }
      case 'read': {
        const r = notes.read(need(a, 'a path'));
        if (!r) { io.stderr(`no note ${a}\n`); return 3; }
        if (env.json) renderJson(io, r); else io.stdout(r.body.endsWith('\n') ? r.body : `${r.body}\n`);
        return 0;
      }
      case 'list': {
        const rows = notes.list({ ...(a ? { prefix: a } : {}), ...(parsed.values.limit ? { limit: Number(parsed.values.limit) } : {}) });
        if (env.json) renderJson(io, rows); else io.stdout(rows.map((r) => `${r.updated.slice(0, 10)}  ${r.lifespan.padEnd(5)}${r.pinned ? ' pinned' : ''}  ${r.path}${r.files ? `  (${r.files} file${r.files === 1 ? '' : 's'})` : ''}\n`).join(''));
        return 0;
      }
      case 'attach': {
        const file = need(b, 'a file');
        const f = notes.attach(need(a, 'a path'), parsed.values.name ?? basename(file), file, parsed.values.type ? { type: parsed.values.type } : {});
        if (env.json) renderJson(io, f); else io.stdout(`${a}: ${f.name} (${f.bytes} bytes)\n`);
        return 0;
      }
      case 'file': {
        const p = notes.filePath(need(a, 'a path'), need(b, "a file's name"));
        if (!p) { io.stderr(`no file ${b} on ${a}\n`); return 3; }
        await new Promise<void>((res, rej) => createReadStream(p).on('error', rej).on('end', res).pipe(process.stdout, { end: false }));
        return 0;
      }
      case 'pin': case 'unpin': {
        const r = notes.pin(need(a, 'a path'), sub === 'pin');
        if (env.json) renderJson(io, r); else io.stdout(`${r.path} ${r.pinned ? 'pinned' : `unpinned${r.expires ? `, until ${r.expires.slice(0, 10)}` : ''}`}\n`);
        return 0;
      }
      case 'delete': {
        const gone = notes.delete(need(a, 'a path'));
        io.stdout(gone ? `deleted ${a}\n` : `no note ${a}\n`);
        return gone ? 0 : 3;
      }
      case 'sweep': {
        const cited = citedPaths(env.contextDir);
        const extra = parsed.values.cited;
        if (extra) {
          const text = extra === '-' ? await readStdin(io.stdin) : await readStdin(createReadStream(extra));
          for (const l of text.split('\n')) if (l.trim()) cited.add(l.trim());
        }
        const r = notes.sweep(cited, { dryRun: !!parsed.values['dry-run'] });
        if (env.json) renderJson(io, r); else io.stdout(`${parsed.values['dry-run'] ? 'would let go' : 'let go'}: ${r.gone.length}; kept for a citation: ${r.keptCited.length}\n${r.gone.map((p) => `  - ${p}\n`).join('')}`);
        return 0;
      }
    }
    return 2;
  } catch (err) {
    if (err instanceof NoteError) { io.stderr(`${err.message}\n`); return err.status === 2 ? 2 : 1; }
    throw err;
  } finally {
    notes.close();
  }
}
