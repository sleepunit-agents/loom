/**
 * loom migrate — report and apply pending schema migrations to memories.db.
 *
 * Exits 0 when all migrations applied or already up to date.
 * Exits 1 when any migration fails (and prints the error).
 * Use --dry-run to report pending migrations without applying them.
 */
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations, pendingMigrations } from '../backends/migrations.js';
import { resolveSqliteDbPath } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom migrate [options]

Report and apply pending schema migrations to memories.db.
Exits non-zero if any migration fails.

Options:
  --dry-run          Show pending migrations without applying them
  --json             Machine-readable output
  --context-dir <p>  Agent context dir (default: $LOOM_CONTEXT_DIR or ~/.config/loom/default)
  --help, -h         Show this help
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const env = resolveEnv(global, io.env);
  const dbPath = resolveSqliteDbPath(env.contextDir);
  const json = env.json || Boolean(global.json);
  const dryRun = Boolean(parsed.values['dry-run']);

  if (!existsSync(dbPath)) {
    if (json) {
      renderJson(io, { dbPath, status: 'no_db', migrations: [] });
    } else {
      io.stdout(`No memories.db found at ${dbPath} — nothing to migrate.\n`);
    }
    return 0;
  }

  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');

  try {
    if (dryRun) {
      const pending = pendingMigrations(db);
      if (json) {
        renderJson(io, {
          dbPath,
          status: 'dry_run',
          pending: pending.map((m) => ({ id: m.id, description: m.description })),
        });
      } else if (pending.length === 0) {
        io.stdout(`memories.db is up to date. No pending migrations.\n`);
      } else {
        io.stdout(`Pending migrations (${pending.length}):\n`);
        for (const m of pending) {
          io.stdout(`  - ${m.id}: ${m.description}\n`);
        }
      }
      return 0;
    }

    const results = runMigrations(db, { strict: false });
    const applied = results.filter((r) => r.status === 'applied');
    const failed = results.filter((r) => r.status === 'failed');

    if (json) {
      renderJson(io, {
        dbPath,
        status: failed.length > 0 ? 'error' : 'ok',
        migrations: results,
      });
    } else if (failed.length > 0) {
      for (const r of failed) {
        io.stderr(`Migration '${r.id}' failed: ${r.error}\n`);
      }
      if (applied.length > 0) {
        io.stdout(`Applied ${applied.length} migration${applied.length === 1 ? '' : 's'} before failure.\n`);
      }
    } else if (applied.length === 0) {
      io.stdout(`memories.db is already up to date.\n`);
    } else {
      io.stdout(`Applied ${applied.length} migration${applied.length === 1 ? '' : 's'}:\n`);
      for (const r of applied) {
        io.stdout(`  - ${r.id}: ${r.description}\n`);
      }
    }

    return failed.length > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}
