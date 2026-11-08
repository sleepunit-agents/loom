/**
 * loom inject — write a marker-bounded managed section into each
 * selected harness's dotfile. Composes with user content; idempotent.
 *
 * This file only wires the flag-driven (non-interactive) path; the
 * interactive wizard is added in Task 7.
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import type { IOStreams } from './io.js';
import { renderJson, stderrWritable } from './io.js';
import { multiSelect } from './tui/multi-select.js';
import {
  HARNESSES,
  HARNESS_KEYS,
  isHarnessKey,
  resolveHarnessPath,
  type HarnessKey,
  type HarnessPreset,
} from '../injection/harnesses.js';
import { renderBlock } from '../injection/render.js';
import {
  writeManagedBlock,
  MalformedMarkersError,
  findMarkers,
  buildContent,
  normalizeLF,
  type WriteAction,
  type WriteResult,
} from '../injection/writer.js';
import { readFile } from 'node:fs/promises';

const USAGE = `Usage: loom inject [options]

Writes a managed section into each selected harness's dotfile telling
the agent how to load identity via loom. Re-running is idempotent;
content outside the <!-- loom:start / loom:end --> markers is preserved.

Options:
  --harness <keys>       Comma-separated subset of: ${HARNESS_KEYS.join(', ')}
  --all                  Inject into all default harnesses (exclusive with --harness)
  --to <path>            Override target path (valid only when exactly one harness is selected)
  --dry-run              Print unified diff; write nothing
  --json                 Machine-readable output
  --context-dir <path>   Agent context dir (default: $LOOM_CONTEXT_DIR)
  --help, -h             Show this help

With no harness flags, runs the interactive wizard on a TTY; exits 2
on non-TTY stdin.
`;

interface InjectTarget {
  harness: HarnessPreset;
  path: string;
}

interface ReportRow {
  harness: HarnessKey;
  path: string;
  action: WriteAction;
  bytesWritten: number;
  diff?: string;
}


const wizardOverrides = new Map<HarnessKey, string>();

/** Minimal line-level diff (Myers-lite via LCS table). Good enough for
 *  a managed-block preview; avoids pulling in a dependency. */
function lineDiff(oldText: string, newText: string): string[] {
  const A = oldText.split('\n');
  const B = newText.split('\n');
  const n = A.length, m = B.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (A[i] === B[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1;
      else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(` ${A[i]}`); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push(`-${A[i]}`); i++; }
    else { out.push(`+${B[j]}`); j++; }
  }
  while (i < n) { out.push(`-${A[i]}`); i++; }
  while (j < m) { out.push(`+${B[j]}`); j++; }
  return out;
}

function makeDiff(existing: string, next: string, path: string): string {
  const header = `--- ${path}\n+++ ${path}\n`;
  const hunk = lineDiff(existing, next);
  return header + hunk.join('\n') + (hunk.length ? '\n' : '');
}

async function planTargets(
  harnesses: HarnessKey[],
  toOverride: string | undefined,
  envHome: string | undefined,
): Promise<InjectTarget[] | { error: string; code: 2 }> {
  if (toOverride !== undefined && harnesses.length !== 1) {
    return {
      error: 'loom inject: --to requires exactly a single --harness value',
      code: 2,
    };
  }
  const targets = harnesses.map((key) => {
    const override = toOverride ?? wizardOverrides.get(key);
    return {
      harness: HARNESSES[key],
      path: override ?? resolveHarnessPath(HARNESSES[key], envHome),
    };
  });
  wizardOverrides.clear();
  return targets;
}

async function executeTargets(
  targets: InjectTarget[],
  contextDir: string,
  opts: { dryRun: boolean },
): Promise<{ rows: ReportRow[]; hadError: boolean; lastError?: Error }> {
  const rows: ReportRow[] = [];
  let hadError = false;
  let lastError: Error | undefined;
  for (const t of targets) {
    const block = renderBlock(t.harness, contextDir);
    try {
      if (opts.dryRun) {
        const existing = await readFile(t.path, 'utf-8').catch((e) => {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw e;
        });
        const norm = existing === null ? null : normalizeLF(existing);
        const markers = norm === null ? null : findMarkers(norm, t.path);
        const { next, action } = buildContent(norm, block, markers);
        rows.push({
          harness: t.harness.key,
          path: t.path,
          action,
          bytesWritten: 0,
          diff: makeDiff(norm ?? '', next, t.path),
        });
      } else {
        const res: WriteResult = await writeManagedBlock(t.path, block);
        rows.push({
          harness: t.harness.key,
          path: res.path,
          action: res.action,
          bytesWritten: res.bytesWritten,
        });
      }
    } catch (err) {
      hadError = true;
      lastError = err as Error;
      rows.push({
        harness: t.harness.key,
        path: t.path,
        action: 'no-change',
        bytesWritten: 0,
      });
    }
  }
  return { rows, hadError, lastError };
}

function humanActionLabel(action: WriteAction): string {
  switch (action) {
    case 'created': return 'created';
    case 'appended': return 'appended';
    case 'updated': return 'updated';
    case 'no-change': return 'no change';
  }
}

function writeHumanReport(rows: ReportRow[], io: IOStreams): void {
  for (const r of rows) {
    io.stdout(`${r.harness}: ${r.path} (${humanActionLabel(r.action)})\n`);
  }
}

function writeDiffReport(rows: ReportRow[], io: IOStreams): void {
  for (const r of rows) {
    if (r.diff) io.stdout(r.diff);
  }
}

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        harness: { type: 'string' },
        all:     { type: 'boolean' },
        to:      { type: 'string' },
        'dry-run': { type: 'boolean' },
        help:    { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }

  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  if (parsed.values.harness !== undefined && parsed.values.all === true) {
    io.stderr('loom inject: --harness and --all are mutually exclusive\n');
    return 2;
  }

  let harnesses: HarnessKey[] | null = null;
  if (parsed.values.all === true) {
    harnesses = [...HARNESS_KEYS];
  } else if (parsed.values.harness !== undefined) {
    const parts = parsed.values.harness.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      if (!isHarnessKey(p)) {
        io.stderr(`loom inject: unknown harness '${p}' (valid: ${HARNESS_KEYS.join(', ')})\n`);
        return 2;
      }
    }
    harnesses = parts as HarnessKey[];
  }

  if (harnesses === null) {
    if (!io.stdinIsTTY) {
      io.stderr('loom inject: --harness or --all required when stdin is not a TTY\n');
      return 2;
    }
    const chosen = await multiSelect<HarnessKey>({
      title: 'Select harnesses to inject loom into:',
      items: HARNESS_KEYS.map((k) => {
        const home = io.env.HOME ?? '';
        const defaultPath = resolveHarnessPath(HARNESSES[k], io.env.HOME);
        const display = home ? defaultPath.replace(new RegExp(`^${home}`), '~') : defaultPath;
        return {
          value: k,
          label: HARNESSES[k].display,
          detail: display,
        };
      }),
      initialSelected: new Set(HARNESS_KEYS),
    });
    if (chosen === null) {
      io.stderr('loom inject: cancelled\n');
      return 130;
    }
    harnesses = [...chosen];
    if (harnesses.length === 0) {
      io.stderr('loom inject: no harnesses selected\n');
      return 2;
    }
    const rl = createInterface({ input: io.stdin, output: stderrWritable(io) });
    try {
      io.stderr('\nPress enter to accept defaults, or type a path:\n');
      for (const k of harnesses) {
        const defaultPath = resolveHarnessPath(HARNESSES[k], io.env.HOME);
        const ans = (await rl.question(
          `  ${HARNESSES[k].display} [${defaultPath}]: `,
        )).trim();
        if (ans.length > 0) wizardOverrides.set(k, ans);
      }
    } finally {
      rl.close();
    }
  }

  const envR = resolveEnv(global, io.env);
  try {
    assertStackVersionCompatible(envR.contextDir);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }

  const plan = await planTargets(harnesses, parsed.values.to, io.env.HOME);
  if ('error' in plan) {
    io.stderr(`${plan.error}\n`);
    return plan.code;
  }

  const dryRun = parsed.values['dry-run'] === true;
  const json = global.json === true;

  let report;
  try {
    report = await executeTargets(plan, envR.contextDir, { dryRun });
  } catch (err) {
    if (err instanceof MalformedMarkersError) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    io.stderr(`loom inject: ${(err as Error).message}\n`);
    return 1;
  }

  if (json) {
    renderJson(io, report.rows);
  } else if (dryRun) {
    writeDiffReport(report.rows, io);
  } else {
    writeHumanReport(report.rows, io);
  }

  if (report.hadError) {
    if (report.lastError instanceof MalformedMarkersError) {
      io.stderr(`${report.lastError.message}\n`);
    } else if (report.lastError) {
      io.stderr(`loom inject: ${report.lastError.message}\n`);
    }
    return 1;
  }
  return 0;
}
