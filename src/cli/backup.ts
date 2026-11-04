/**
 * `loom backup` (src/backup.ts; docs/specs/keeping-watch.md, "1. The nightly backup"). Local only.
 */
import { householdHome, loadHousehold } from '../household.js';
import {
  BackupError, backupProblem, clearSettings, isDue, lastSlot, readSettings, readState, runBackup, setSettings, takeLock, targetString,
  tickBackup, validateSettings,
} from '../backup.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom backup set --target git:<url>|path:<dir> --recipient <age1…> [--recipient …] [--at HH:MM] [--tz Zone] [--keep N]
       loom backup run            export, drill and write one now
       loom backup status [--json]
       loom backup off            stop the nightly backup (its bundles stay where they are)

Each night at --at (default 03:00, in --tz), loom exports the household, encrypted
to the --recipient keys (the owner's) and to this machine's own drill key
($LOOM_HOME/backup/drill.key, made here, never in a bundle), restores it into a
throwaway home and compares it with the live one, then writes it to the target:

  git:<url>   a repo loom owns: the branch is one commit holding the newest
              --keep nights (default 7) and each month's first. It pushes with
              this user's own git credentials; loom stores none.
  path:<dir>  a directory (a USB stick, a NAS): the same bundles, as files.

A target that holds anything loom didn't write is refused.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function all(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1] !== undefined) out.push(args[++i]);
  return out;
}

export async function runBackupCli(argv: string[], io: IOStreams): Promise<number> {
  const [verb, ...rest] = argv;
  if (!verb || verb === '--help' || verb === '-h' || rest.includes('--help')) { io.stdout(USAGE); return verb ? 0 : 2; }
  const home = householdHome(io.env);
  const h = loadHousehold(home);
  if (!h) { io.stderr(`loom backup: there's no household at ${home} (household.json)\n`); return 1; }
  try {
    switch (verb) {
      case 'set': {
        const s = validateSettings({ target: flag(rest, '--target'), recipients: all(rest, '--recipient'), at: flag(rest, '--at'), tz: flag(rest, '--tz'), keep: flag(rest, '--keep') },
          Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
        const { drillRecipient } = setSettings(h, s, io.env);
        io.stdout(`The nightly backup is set: ${targetString(s.target)}, each day at ${s.at} (${s.tz}), keeping ${s.keep} nights and each month's first.\n`
          + `Encrypted to ${s.recipients.length} key${s.recipients.length === 1 ? '' : 's'} of yours, and to this machine's drill key (${drillRecipient}).\n`);
        return 0;
      }
      case 'off': {
        clearSettings(h);
        io.stdout('The nightly backup is off. Its bundles stay where they are.\n');
        return 0;
      }
      case 'run': {
        const lock = takeLock(home);
        if (!lock) { io.stderr('loom backup: a backup is running already\n'); return 1; }
        try {
          const r = await runBackup({ home, env: io.env });
          if (rest.includes('--json')) { io.stdout(JSON.stringify(r, null, 2) + '\n'); return r.ok ? 0 : 1; }
          if (r.ok) io.stdout(`Backed up: ${r.name} (${((r.bytes ?? 0) / 1048576).toFixed(1)} MB${r.parts && r.parts > 1 ? `, in ${r.parts} parts` : ''}), drill passed${r.drill && r.drill.tries > 1 ? ' on its second try' : ''}${r.commit ? `, pushed ${r.commit.slice(0, 12)}` : ''}.\n`);
          else io.stderr(`The backup failed: ${r.why}\n`);
          return r.ok ? 0 : 1;
        } finally { lock.release(); }
      }
      case 'tick': {
        const r = await tickBackup({ home, env: io.env });
        io.stdout(`${r}\n`);
        return 0;
      }
      case 'status': {
        const { settings: s, problem } = readSettings(h);
        const st = readState(home);
        const p = backupProblem(h);
        if (rest.includes('--json')) {
          io.stdout(JSON.stringify({ settings: s ? { ...s, target: targetString(s.target) } : null, problem: problem ?? null, now: p, lastGood: st.lastGood ?? null, runs: st.runs.slice(0, 5),
            due: s ? isDue(s, st, Date.now()) : false, lastSlot: s ? new Date(lastSlot(s, Date.now())).toISOString() : null }, null, 2) + '\n');
          return 0;
        }
        if (!s && !problem) { io.stdout('The nightly backup isn\'t set up (loom backup set).\n'); return 0; }
        if (problem) io.stdout(`Its settings don't work: ${problem}\n`);
        if (s) io.stdout(`To ${targetString(s.target)}, each day at ${s.at} (${s.tz}), keeping ${s.keep} nights and each month's first.\n`);
        const g = st.lastGood;
        io.stdout(g ? `Last good: ${g.at} ${g.name} (${((g.bytes ?? 0) / 1048576).toFixed(1)} MB), drill passed${g.commit ? `, commit ${g.commit.slice(0, 12)}` : ''}.\n` : 'No good backup yet.\n');
        if (p) io.stdout(`Now: ${p.text}: ${p.meta}\n`);
        return 0;
      }
      default:
        io.stderr(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof BackupError) { io.stderr(`loom backup: ${e.message}\n`); return 1; }
    throw e;
  }
}
