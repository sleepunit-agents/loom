/**
 * Pieces — `loom <piece> ...` runs the installed extension `loom-<piece>`
 * (docs/extensions.md, t-1466).
 *
 * Git-style dispatch: an executable named `loom-tasks` on PATH answers
 * `loom tasks list`. loom doesn't know what a piece does and never links its
 * code: the piece is its own program, reached as its own process, so it can't
 * reach into loom's stores and can be swapped for anything else that installs
 * the same name and honors that piece's contract.
 *
 * Core subcommands always win (a `loom-recall` on PATH is never consulted),
 * and a name must match PIECE_NAME before PATH is searched at all.
 */
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { SUBCOMMANDS } from './subcommands.js';
import type { IOStreams } from './io.js';
import { managedBinDir, pieceEnvFor } from './pieces-managed.js';

/** A piece name: lowercase, starts with a letter, no dots or slashes. */
export const PIECE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const PREFIX = 'loom-';

const CORE: ReadonlySet<string> = new Set(SUBCOMMANDS);

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where pieces are looked for: the managed ones first (docs/specs/pieces-install.md), then PATH. */
function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const managed = managedBinDir(env);
  return [...(managed ? [managed] : []), ...(env.PATH ?? '').split(delimiter).filter(Boolean)];
}

/** Whether `name` could be a piece (valid name, not a core subcommand). */
export function isPieceName(name: string | undefined): name is string {
  return name !== undefined && PIECE_NAME.test(name) && !CORE.has(name);
}

/** The executable that answers `loom <name>`: a managed one, else the first `loom-<name>` on PATH. */
export function findPiece(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!isPieceName(name)) return undefined;
  for (const dir of pathDirs(env)) {
    const candidate = join(dir, PREFIX + name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export interface InstalledPiece {
  name: string;
  path: string;
}

/** Every installed piece, first on PATH wins (the one `loom <name>` would run). */
export function listPieces(env: NodeJS.ProcessEnv): InstalledPiece[] {
  const seen = new Map<string, string>();
  for (const dir of pathDirs(env)) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries.sort()) {
      if (!entry.startsWith(PREFIX)) continue;
      const name = entry.slice(PREFIX.length);
      if (seen.has(name) || !isPieceName(name)) continue;
      const path = join(dir, entry);
      if (isExecutableFile(path)) seen.set(name, path);
    }
  }
  return [...seen].map(([name, path]) => ({ name, path })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Run a piece with `args`, passing loom's env through (plus, for a managed
 * piece, its own: pieceEnvFor). With the
 * process's own streams the piece inherits the terminal (so it can prompt,
 * e.g. for a secret's value); with captured streams (tests) its output is
 * forwarded. Exit code: the piece's own, 128+signal if it was killed, 127 if
 * it couldn't start.
 */
export async function runPiece(path: string, args: string[], io: IOStreams): Promise<number> {
  const inherit = io.stdin === process.stdin;
  const child = spawn(path, args, {
    env: pieceEnvFor(path, io.env),
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  });
  if (!inherit) {
    child.stdout?.on('data', (d: Buffer) => io.stdout(d.toString()));
    child.stderr?.on('data', (d: Buffer) => io.stderr(d.toString()));
    if (child.stdin) {
      if (io.stdinIsTTY) child.stdin.end();
      else io.stdin.pipe(child.stdin);
    }
  }
  return new Promise<number>((resolve) => {
    child.on('error', (err) => {
      io.stderr(`loom: couldn't run ${path}: ${err.message}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => {
      if (signal) resolve(128 + (osConstants.signals[signal] ?? 0));
      else resolve(code ?? 1);
    });
  });
}

/** `loom pieces`: what's installed, and installing managed pieces (docs/specs/pieces-install.md). */
export async function runPiecesCommand(argv: string[], io: IOStreams): Promise<number> {
  const json = argv.includes('--json');
  const rest = argv.filter((a) => a !== '--json');
  if (rest.includes('--help') || rest.includes('-h')) {
    io.stdout(PIECES_USAGE);
    return 0;
  }
  const m = await import('./pieces-managed.js');
  const [verb, ...args] = rest;
  const out = (value: unknown, text: string) => io.stdout(json ? JSON.stringify(value, null, 2) + '\n' : text);
  try {
    switch (verb) {
      case undefined: {
        const managed = new Map(m.managedPieces(io.env).map((r) => [r.name, r]));
        const catalog = new Map(m.readCatalog().map((c) => [c.name, c]));
        const pieces = listPieces(io.env).map((p) => {
          const r = managed.get(p.name);
          if (!r || !r.bins.includes(`loom-${p.name}`) || !p.path.startsWith(m.managedBinDir(io.env) + '/')) return p;
          const c = catalog.get(p.name);
          const missing = m.missingSettings(io.env, r);
          return { ...p, managed: { version: r.version, commit: r.source.commit, repo: r.source.repo,
            ...(c && c.commit !== r.source.commit && c.repo === r.source.repo ? { update: c.commit } : {}),
            ...(missing.length ? { needsSetup: missing } : {}) } };
        });
        if (json) { out(pieces, ''); return 0; }
        io.stdout(pieces.length === 0
          ? 'no pieces installed (loom pieces catalog lists what loom can install)\n'
          : pieces.map((p) => {
            const g = 'managed' in p ? p.managed : undefined;
            const note = g ? `\tmanaged ${g.version || g.commit.slice(0, 12)}${g.update ? ', update available' : ''}${g.needsSetup ? `, needs ${g.needsSetup.join(', ')}` : ''}` : '';
            return `${p.name}\t${p.path}${note}`;
          }).join('\n') + '\n');
        return 0;
      }
      case 'catalog': {
        const installed = new Map(m.managedPieces(io.env).map((r) => [r.name, r]));
        const cat = m.readCatalog();
        out(cat, cat.map((c) => `${c.name}\t${c.label ?? ''}\t${installed.get(c.name)?.source.commit === c.commit ? 'installed' : installed.has(c.name) ? 'update available' : ''}\n  ${c.description ?? ''}`).join('\n') + '\n');
        return 0;
      }
      case 'install': {
        const from = args.indexOf('--from');
        let source: { repo: string; commit: string };
        let name: string | undefined;
        if (from >= 0) {
          if (args.length !== 2 && !(args.length === 3 && args.includes('--yes'))) throw new m.PieceError('install --from takes one source (and --yes)');
          source = m.parseSource(args[from + 1] ?? '');
          if (!args.includes('--yes')) {
            io.stderr(`${source.repo} isn't in loom's catalog. A piece runs as you, and npm runs its build scripts while it installs: installing it is running it.\nRun again with --yes to install it.\n`);
            return 2;
          }
        } else {
          if (args.length !== 1) throw new m.PieceError('install takes a catalog name, or --from github:<owner>/<repo>#<commit>');
          const c = m.readCatalog().find((x) => x.name === args[0]);
          if (!c) throw new m.PieceError(`${args[0]} isn't in the catalog (loom pieces catalog)`);
          source = { repo: c.repo, commit: c.commit };
          name = c.name;
        }
        const r = await m.installPiece(io.env, source, name);
        out(r, `${r.updated ? 'updated' : 'installed'} ${r.record.name} ${r.record.version} (${r.record.source.repo}@${r.record.source.commit.slice(0, 12)})\n`
          + (r.missing.length ? `it needs settings: loom pieces set ${r.record.name} ${r.missing.map((x) => `${x}=…`).join(' ')}\n` : '')
          + (r.services.started.length ? `running: ${r.services.started.join(', ')}\n` : '')
          + r.services.notes.map((n) => n + '\n').join(''));
        return 0;
      }
      case 'update': {
        if (args.length !== 1) throw new m.PieceError('update takes a piece name');
        const rec = m.readRecord(io.env, args[0]);
        if (!rec) throw new m.PieceError(`${args[0]} isn't a managed piece`);
        const c = m.readCatalog().find((x) => x.name === rec.name && x.repo === rec.source.repo);
        if (!c) throw new m.PieceError(`${rec.name} isn't from the catalog; install the commit you want with --from`);
        if (c.commit === rec.source.commit) { out({ record: rec, updated: false }, `${rec.name} is already the catalog's ${c.commit.slice(0, 12)}\n`); return 0; }
        const r = await m.installPiece(io.env, { repo: c.repo, commit: c.commit }, rec.name);
        out(r, `updated ${rec.name} to ${r.record.version} (${c.commit.slice(0, 12)}); loom pieces rollback ${rec.name} goes back\n`);
        return 0;
      }
      case 'rollback': {
        if (args.length !== 1) throw new m.PieceError('rollback takes a piece name');
        const r = m.rollbackPiece(io.env, args[0]);
        out(r, `${r.name} is back on ${r.version} (${r.source.commit.slice(0, 12)})\n`);
        return 0;
      }
      case 'remove': {
        const purge = args.includes('--purge');
        const names = args.filter((a) => a !== '--purge');
        if (names.length !== 1) throw new m.PieceError('remove takes a piece name (and --purge)');
        m.removePiece(io.env, names[0], purge);
        out({ removed: names[0], purged: purge }, `removed ${names[0]}${purge ? ', with its settings and data' : '; its settings and data are kept (--purge deletes them)'}\n`);
        return 0;
      }
      case 'set': {
        const [name, ...pairs] = args;
        if (!name || !pairs.length) throw new m.PieceError('set takes a piece name and NAME=value pairs');
        const values: Record<string, string> = {};
        for (const p of pairs) {
          const i = p.indexOf('=');
          if (i <= 0) throw new m.PieceError(`${p} isn't NAME=value`);
          values[p.slice(0, i)] = p.slice(i + 1);
        }
        const now = m.setSettings(io.env, name, values);
        out(now, `${name}: ${Object.keys(now).length ? Object.keys(now).join(', ') : 'no settings'} set\n`);
        return 0;
      }
      default:
        io.stderr(`loom pieces: no verb ${verb}.\n${PIECES_USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof m.PieceError) {
      io.stderr(`loom pieces: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

export const PIECES_USAGE = `Usage: loom pieces [--json]
       loom pieces catalog [--json]
       loom pieces install <name> | --from github:<owner>/<repo>#<commit> [--yes]
       loom pieces update <name>
       loom pieces rollback <name>
       loom pieces remove <name> [--purge]
       loom pieces set <name> NAME=value...

With no verb, list the installed pieces: every executable named loom-<name>
that answers \`loom <name> ...\`. Managed pieces (installed by loom, under
$LOOM_HOME/pieces) are found first, then PATH; core commands can't be shadowed.
The rest install, update, roll back, remove and set up managed pieces. See
docs/extensions.md and docs/specs/pieces-install.md.
`;
