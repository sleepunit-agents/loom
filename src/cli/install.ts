/**
 * loom install — write the bundled SKILL.md into a target harness's
 * skills directory. Flag-driven for scripting; single-select TUI on a
 * TTY when no --harness is given. See stack spec v1 §11 (Adapters).
 */
import { parseArgs } from 'node:util';
import { resolve as pathResolve } from 'node:path';
import { extractGlobalFlags } from './args.js';
import type { IOStreams } from './io.js';
import { renderJson } from './io.js';
import {
  INSTALL_TARGETS,
  INSTALL_TARGET_KEYS,
  isInstallTargetKey,
  resolveSkillPath,
  type InstallTargetKey,
} from '../install/harnesses.js';
import { writeSkill, type WriteAction } from '../install/render.js';
import { multiSelect } from './tui/multi-select.js';

const USAGE = `Usage: loom install [options]

Writes the loom-setup skill into a target harness's skills directory.
On a TTY with no --harness flag, runs a single-select picker.

Options:
  --harness <key>        One of: ${INSTALL_TARGET_KEYS.join(', ')}
  --to <path>            Override destination path (requires --harness)
  --force                Overwrite an existing skill file
  --dry-run              Report action without writing
  --json                 Emit { target, path, action } and suppress prose
  --help, -h             Show this help

The "other" target writes ./loom-setup-skill.md in the current directory
unless --to overrides.
`;

async function pickHarnessInteractive(_io: IOStreams): Promise<InstallTargetKey | null> {
  const items = INSTALL_TARGET_KEYS.map((k) => ({
    value: k,
    label: INSTALL_TARGETS[k].label,
    detail: INSTALL_TARGETS[k].skillDir ?? '(writes to current directory)',
  }));
  const picked = await multiSelect({
    title: 'Install loom-setup skill into which harness?',
    items,
    single: true,
  });
  if (!picked) return null;
  const arr = [...picked];
  if (arr.length === 0) return null;
  return arr[0];
}

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        harness: { type: 'string' },
        to:      { type: 'string' },
        force:   { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        json:    { type: 'boolean' },
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

  const force  = Boolean(parsed.values.force);
  const dryRun = Boolean(parsed.values['dry-run']);
  const json   = Boolean(parsed.values.json) || Boolean(global.json);

  let key: InstallTargetKey;
  if (parsed.values.harness !== undefined) {
    if (!isInstallTargetKey(parsed.values.harness)) {
      io.stderr(`Unknown harness: ${parsed.values.harness}. Choose one of: ${INSTALL_TARGET_KEYS.join(', ')}.\n`);
      return 2;
    }
    key = parsed.values.harness;
  } else if (io.stdinIsTTY) {
    const picked = await pickHarnessInteractive(io);
    if (!picked) { io.stderr('Cancelled.\n'); return 1; }
    key = picked;
  } else {
    io.stderr(`--harness is required when stdin is not a TTY.\n${USAGE}`);
    return 2;
  }

  const target = INSTALL_TARGETS[key];

  let dest: string;
  if (parsed.values.to !== undefined) {
    dest = pathResolve(parsed.values.to);
  } else if (key === 'other') {
    dest = pathResolve(process.cwd(), 'loom-setup-skill.md');
  } else {
    const p = resolveSkillPath(target);
    if (p === null) {
      io.stderr(`Internal error: target ${key} has no skillDir and --to was not provided.\n`);
      return 2;
    }
    dest = p;
  }

  const res = await writeSkill(dest, { force, dryRun });

  if (json) {
    renderJson(io, { target: key, path: res.path, action: res.action });
    return 0;
  }

  const verb = actionVerb(res.action);
  const lines = [
    `${verb} ${res.path}`,
    '',
    `Next: open ${target.label}. ${firstLetterUpper(target.invoke)}.`,
    `After the skill finishes, ${target.restart}.`,
  ];
  io.stdout(lines.join('\n') + '\n');
  return 0;
}

function actionVerb(a: WriteAction): string {
  switch (a) {
    case 'created':         return 'Wrote';
    case 'skipped-exists':  return 'Already up to date at';
    case 'skipped-stale':   return 'Skill file is outdated (re-run with --force to overwrite):';
    case 'overwritten':     return 'Overwrote';
  }
}

function firstLetterUpper(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
