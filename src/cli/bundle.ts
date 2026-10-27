/**
 * `loom export` and `loom restore` (src/bundle.ts; docs/specs/household.md,
 * "Export and restore"). Local only: neither is a remote verb.
 */
import { householdHome } from '../household.js';
import { BundleError, drillBundle, exportBundle, restoreBundle, sizeOf } from '../bundle.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import type { IOStreams } from './io.js';

const EXPORT_USAGE = `Usage: loom export --to <file> --recipient <age1…> [--recipient …]

Write the whole household to one file, encrypted to the owner's key (an age
public key, or an ssh public key). Inside: the household's files, the commons,
every agent's directory, and each installed piece's own part, which the piece
encrypts itself (loom-<piece> bundle export). A plain context dir exports as a
household of one.
`;

const RESTORE_USAGE = `Usage: loom restore <file> --identity <key file> [--to <dir>] [--no-install]
       loom restore <file> --identity <key file> --drill

Lay a bundle down in an empty LOOM_HOME (--to, else $LOOM_HOME, else
~/.config/loom), install the managed pieces it names at their pinned commits
with their settings (--no-install skips that), then hand each installed piece
its part (loom-<piece> bundle import). A piece that isn't installed keeps its
part in pieces-pending/.

--drill restores into a throwaway directory instead and compares it with the
live household (agents, identities, memories, every card, knowledge, tokens),
then removes it. Nothing live is touched.

A restore trusts what's in the bundle: age encrypts but doesn't prove who made
the file, so only restore bundles you made.
`;

function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[++i]);
  return out;
}

export async function runExport(rawArgv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest: argv } = extractGlobalFlags(rawArgv);
  if (argv.includes('--help') || argv.includes('-h')) { io.stdout(EXPORT_USAGE); return 0; }
  const to = flags(argv, '--to')[0];
  const recipients = flags(argv, '--recipient');
  if (!to || recipients.length === 0) { io.stderr(EXPORT_USAGE); return 2; }
  const { contextDir } = resolveEnv(global, io.env);
  try {
    const m = await exportBundle({ contextDir, to, recipients, env: io.env });
    const left = m.pieces.filter((p) => !p.included);
    io.stdout(`Bundle written: ${to} (${(sizeOf(to) / 1048576).toFixed(1)} MB), agents ${m.household.agents.join(', ')}.\n`);
    for (const p of m.pieces.filter((x) => x.included)) io.stdout(`  piece ${p.name}: included (${p.bytes} bytes, encrypted by the piece)\n`);
    for (const p of left) io.stdout(`  piece ${p.name}: not included (${p.reason})\n`);
    return 0;
  } catch (err) {
    if (err instanceof BundleError) { io.stderr(`${err.message}\n`); return 1; }
    throw err;
  }
}

export async function runRestore(rawArgv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest: argv } = extractGlobalFlags(rawArgv);
  if (argv.includes('--help') || argv.includes('-h')) { io.stdout(RESTORE_USAGE); return 0; }
  const file = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));
  const identity = flags(argv, '--identity')[0];
  if (!file || !identity) { io.stderr(RESTORE_USAGE); return 2; }
  try {
    if (argv.includes('--drill')) {
      const { contextDir } = resolveEnv(global, io.env);
      const r = await drillBundle({ file, identity, contextDir, env: io.env });
      if (r.ok) {
        io.stdout(`Drill passed: the bundle from ${r.manifest.created} restores to a household that matches the live one.\n`);
        return 0;
      }
      io.stdout(`Drill found ${r.differences.length} difference${r.differences.length === 1 ? '' : 's'} (the live household may simply have moved on since ${r.manifest.created}):\n`);
      for (const d of r.differences) io.stdout(`  ${d.what}: live ${JSON.stringify(d.live)}, restored ${JSON.stringify(d.restored)}\n`);
      return 1;
    }
    const home = flags(argv, '--to')[0] ?? householdHome(io.env);
    const r = await restoreBundle({ file, identity, home, env: io.env, ...(argv.includes('--no-install') ? { install: false as const } : {}) });
    io.stdout(`Restored the household (${r.manifest.household.agents.join(', ')}, bundle from ${r.manifest.created}) to ${r.home}.\n`);
    for (const p of r.installs) io.stdout(`  installed ${p.name} at ${p.commit.slice(0, 7)}: ${p.installed ? 'yes' : `no (${p.reason})`}\n`);
    for (const p of r.pieces) io.stdout(`  piece ${p.name}: ${p.restored ? 'restored' : `not restored (${p.reason})`}\n`);
    return 0;
  } catch (err) {
    if (err instanceof BundleError) { io.stderr(`${err.message}\n`); return 1; }
    throw err;
  }
}
