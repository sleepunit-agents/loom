/**
 * CLI dispatcher — top-level --help / --version plus subcommand routing.
 * Individual subcommand files land in Tasks 2–10.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRepoRoot } from '../config.js';
import type { IOStreams } from './io.js';
import { realStreams } from './io.js';
import { SUBCOMMANDS } from './subcommands.js';
import { firstNonGlobalIndex } from './args.js';

const TOP_HELP = `Usage: loom <command> [options]

Commands:
  wake               Print agent identity to stdout
  recall <query>     Search memories
  remember <title>   Save a new memory (body via stdin/$EDITOR)
  update <ref>       Modify an existing memory
  forget <ref|scope> Remove memories
  memory list|prune|similar|audit
                     Browse / clean / find duplicates / health report
  knowledge write|recall|maintain
                     Write / search / health-report the knowledge store
  update-identity    Edit preferences.md / self-model.md sections
  bootstrap          Initialize a fresh agent
  serve              Explicit MCP stdio startup (same as no args)
  inject             Write loom identity pointer into harness dotfiles
  harness init      Scaffold a harness manifest from template
  install           Write loom-setup skill into a harness's skills dir
  doctor            Probe the loom environment (read-only)
  migrate           Apply pending schema migrations to memories.db

Global flags:
  --context-dir <path>   Agent context dir (default: $LOOM_CONTEXT_DIR or ~/.config/loom/default)
  --client <name>        Harness adapter hint (default: $LOOM_CLIENT)
  --model <name>         Model manifest hint (default: $LOOM_MODEL)
  --json                 Machine-readable output
  --help, -h             Show help
  --version, -V          Print loom version

Run 'loom <command> --help' for per-command usage.
`;

async function readVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(resolveRepoRoot(), 'package.json'), 'utf-8'));
  return pkg.version;
}

export async function runCli(argv: string[], io: IOStreams = realStreams()): Promise<number> {
  // The subcommand is the first token that is not a leading global flag,
  // so the flags the help text calls global work in front of it too. When
  // it is already at argv[0] — the overwhelmingly common form — subIdx is
  // 0 and every line below behaves exactly as it did before.
  const subIdx = firstNonGlobalIndex(argv);
  const first = argv[subIdx];

  if (first === '--help' || first === '-h' || first === undefined) {
    io.stdout(TOP_HELP);
    return 0;
  }
  if (first === '--version' || first === '-V') {
    io.stdout(`loom v${await readVersion()}\n`);
    return 0;
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(first)) {
    io.stderr(`Unknown subcommand: ${first}\n`);
    io.stderr(TOP_HELP);
    return 2;
  }

  const sub = first;
  // Drop only the subcommand token; the globals that preceded it stay in
  // argv so each command's own extractGlobalFlags still sees them.
  const rest = [...argv.slice(0, subIdx), ...argv.slice(subIdx + 1)];
  switch (sub) {
    case 'wake': {
      const { run } = await import('./wake.js');
      return run(rest, io);
    }
    case 'recall': {
      const { run } = await import('./recall.js');
      return run(rest, io);
    }
    case 'memory': {
      const { run } = await import('./memory.js');
      return run(rest, io);
    }
    case 'knowledge': {
      const { run } = await import('./knowledge.js');
      return run(rest, io);
    }
    case 'forget': {
      const { run } = await import('./forget.js');
      return run(rest, io);
    }
    case 'remember': {
      const { run } = await import('./remember.js');
      return run(rest, io);
    }
    case 'update': {
      const { run } = await import('./update.js');
      return run(rest, io);
    }
    case 'bootstrap': {
      const { run } = await import('./bootstrap.js');
      return run(rest, io);
    }
    case 'serve': {
      const { run } = await import('./serve.js');
      return run(rest, io);
    }
    case 'update-identity': {
      const { run } = await import('./update-identity.js');
      return run(rest, io);
    }
    case 'inject': {
      const { run } = await import('./inject.js');
      return run(rest, io);
    }
    case 'harness': {
      const { run } = await import('./harness.js');
      return run(rest, io);
    }
    case 'install': {
      const { run } = await import('./install.js');
      return run(rest, io);
    }
    case 'doctor': {
      const { run } = await import('./doctor.js');
      return run(rest, io);
    }
    case 'migrate': {
      const { run } = await import('./migrate.js');
      return run(rest, io);
    }
    default:
      io.stderr(`Subcommand not implemented yet: ${sub}\n`);
      return 2;
  }
}
