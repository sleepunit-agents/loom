/**
 * `loom export` and `loom restore` (src/bundle.ts; docs/specs/household.md,
 * "Export and restore"). Local only: neither is a remote verb.
 */
import { householdHome } from '../household.js';
import { BundleError, drillBundle, exportBundle, restoreBundle, sizeOf } from '../bundle.js';
import { extractGlobalFlags, parseVerb, resolveEnv } from './args.js';
import type { IOStreams } from './io.js';

const EXPORT_USAGE = `Usage: loom export --to <file> --recipient <age1…> [--recipient …]

Write the whole household to one file, encrypted to the owner's key (an age
public key, or an ssh public key). Inside: the household's files, the commons,
every agent's directory, and each installed piece's own part, which the piece
encrypts itself (loom-<piece> bundle export). A plain context dir exports as a
household of one.
`;

const RESTORE_USAGE = `Usage: loom restore <file> --identity <key file> [--to <dir>] [--no-install] [--allow-outside]
       loom restore <file> --identity <key file> --drill

Lay a bundle down in an empty LOOM_HOME (--to, else $LOOM_HOME, else
~/.config/loom), install the managed pieces it names at their pinned commits
with their settings (--no-install skips that), then hand each installed piece
its part (loom-<piece> bundle import). A piece that isn't installed keeps its
part in pieces-pending/, as does one whose settings name a path outside the
home: --allow-outside, for your own restore onto a new machine, lets them name
one that isn't there yet (one that is, a live store, is always refused).
Services start only when the home is this machine's household.

--drill restores into a throwaway directory instead and compares it with the
live household (agents, identities, memories, every card, knowledge, tokens),
then removes it. Nothing live is touched.

A restore trusts what's in the bundle: age encrypts but doesn't prove who made
the file, so only restore bundles you made.
`;

export async function runExport(rawArgv: string[], io: IOStreams): Promise<number> {
  const { flags: global } = extractGlobalFlags(rawArgv);
  // Every flag parsed, and --help answered, before anything is written (t-1950).
  const p = parseVerb(rawArgv, { to: { type: 'string' }, recipient: { type: 'string', multiple: true } }, EXPORT_USAGE, io);
  if (typeof p === 'number') return p;
  const to = p.values.to as string | undefined;
  const recipients = (p.values.recipient as string[] | undefined) ?? [];
  if (!to || recipients.length === 0 || p.positionals.length) { io.stderr(EXPORT_USAGE); return 2; }
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
  const { flags: global } = extractGlobalFlags(rawArgv);
  // Every flag parsed, and --help answered, before anything is laid down (t-1950).
  const p = parseVerb(rawArgv, {
    identity: { type: 'string' }, to: { type: 'string' }, drill: { type: 'boolean' }, 'no-install': { type: 'boolean' }, 'allow-outside': { type: 'boolean' },
  }, RESTORE_USAGE, io);
  if (typeof p === 'number') return p;
  const [file, ...extra] = p.positionals;
  const identity = p.values.identity as string | undefined;
  if (!file || !identity || extra.length) { io.stderr(RESTORE_USAGE); return 2; }
  try {
    if (p.values.drill) {
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
    const home = (p.values.to as string | undefined) ?? householdHome(io.env);
    const r = await restoreBundle({ file, identity, home, env: io.env, ...(p.values['no-install'] ? { install: false as const } : {}), allowOutside: p.values['allow-outside'] === true });
    io.stdout(`Restored the household (${r.manifest.household.agents.join(', ')}, bundle from ${r.manifest.created}) to ${r.home}.\n`);
    for (const p of r.installs) io.stdout(`  installed ${p.name} at ${p.commit.slice(0, 7)}: ${p.installed ? 'yes' : `no (${p.reason})`}\n`);
    for (const p of r.pieces) io.stdout(`  piece ${p.name}: ${p.restored ? 'restored' : `not restored (${p.reason})`}\n`);
    for (const n of r.notes) io.stdout(`  ${n}\n`);
    return 0;
  } catch (err) {
    if (err instanceof BundleError) { io.stderr(`${err.message}\n`); return 1; }
    throw err;
  }
}
