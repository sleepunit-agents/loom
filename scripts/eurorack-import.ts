/**
 * eurorack-import — CLI entry point for the eurorack → knowledge importer.
 *
 * Usage:
 *   npx tsx scripts/eurorack-import.ts <repo-path> [--dry-run] [--context-dir <dir>]
 *
 * <repo-path>         Local checkout of the jbarket/eurorack repo (required)
 * --dry-run           Print what would be imported without writing
 * --context-dir <dir> Loom context dir (default: LOOM_CONTEXT_DIR or ~/.config/loom/default)
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { importEurorack, renderImportReport, resolveContextDir } from '../src/tools/eurorack-import.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'dry-run':     { type: 'boolean', default: false },
    'context-dir': { type: 'string' },
    help:          { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help || positionals.length === 0) {
  console.log(
    'Usage: npx tsx scripts/eurorack-import.ts <repo-path> [--dry-run] [--context-dir <dir>]\n' +
    '\n' +
    '  <repo-path>         Local checkout of the jbarket/eurorack repo\n' +
    '  --dry-run           Print the import plan without writing to knowledge.db\n' +
    '  --context-dir <dir> Loom context dir (default: LOOM_CONTEXT_DIR or ~/.config/loom/default)\n',
  );
  process.exit(positionals.length === 0 ? 2 : 0);
}

const repoPath = resolve(positionals[0]);
const contextDir = resolveContextDir(values['context-dir']);

const report = await importEurorack({
  repoPath,
  contextDir,
  dryRun: values['dry-run'],
});

console.log(renderImportReport(report));

if (report.pagesFailed > 0) {
  process.exit(1);
}
