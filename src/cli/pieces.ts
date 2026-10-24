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

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? '').split(delimiter).filter(Boolean);
}

/** Whether `name` could be a piece (valid name, not a core subcommand). */
export function isPieceName(name: string | undefined): name is string {
  return name !== undefined && PIECE_NAME.test(name) && !CORE.has(name);
}

/** The executable that answers `loom <name>`: the first `loom-<name>` on PATH. */
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
 * Run a piece with `args`, passing loom's env through unchanged. With the
 * process's own streams the piece inherits the terminal (so it can prompt,
 * e.g. for a secret's value); with captured streams (tests) its output is
 * forwarded. Exit code: the piece's own, 128+signal if it was killed, 127 if
 * it couldn't start.
 */
export async function runPiece(path: string, args: string[], io: IOStreams): Promise<number> {
  const inherit = io.stdin === process.stdin;
  const child = spawn(path, args, {
    env: io.env,
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

/** `loom pieces`: list what's installed. */
export function runPiecesCommand(argv: string[], io: IOStreams): number {
  const json = argv.includes('--json');
  const rest = argv.filter((a) => a !== '--json');
  if (rest.includes('--help') || rest.includes('-h')) {
    io.stdout(PIECES_USAGE);
    return 0;
  }
  if (rest.length) {
    io.stderr(`loom pieces takes no arguments.\n${PIECES_USAGE}`);
    return 2;
  }
  const pieces = listPieces(io.env);
  if (json) {
    io.stdout(JSON.stringify(pieces, null, 2) + '\n');
    return 0;
  }
  io.stdout(
    pieces.length === 0
      ? 'no pieces installed (a piece is an executable named loom-<name> on PATH)\n'
      : pieces.map((p) => `${p.name}\t${p.path}`).join('\n') + '\n',
  );
  return 0;
}

export const PIECES_USAGE = `Usage: loom pieces [--json]

List the installed pieces: every executable named loom-<name> on PATH, which
answers \`loom <name> ...\`. The first one on PATH wins; core commands can't be
shadowed. See docs/extensions.md.
`;
