/**
 * A managed piece's services (docs/specs/pieces-install.md, "Services"): each
 * one it declares is a systemd user unit, loom-piece-<name>-<service>.service,
 * run with the piece's own environment (service.env in its home), restarted on
 * failure. Written and started on install, restarted on update, rollback and a
 * settings change, stopped and removed with the piece.
 *
 * systemctl comes from PATH. Without a user systemd, nothing is written and
 * the caller is told how to start the service by hand.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { managedBinDir, piecesRoot, pieceEnvFor, type PieceRecord } from './pieces-managed.js';

export const unitName = (piece: string, service: string) => `loom-piece-${piece}-${service}.service`;

function unitDir(env: NodeJS.ProcessEnv): string | undefined {
  const config = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : undefined);
  return config ? join(config, 'systemd', 'user') : undefined;
}

function systemctl(env: NodeJS.ProcessEnv, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('systemctl', ['--user', ...args], { env, encoding: 'utf-8', timeout: 30_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Whether there's a user systemd to run services under. */
export function hasSystemd(env: NodeJS.ProcessEnv): boolean {
  return !!unitDir(env) && systemctl(env, 'show-environment').ok;
}

/** One argv word for ExecStart: quoted, with systemd's specifiers and variables escaped. */
function word(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** One EnvironmentFile line: KEY="value" (a setting's value is one line already). */
function envLine(k: string, v: string): string {
  return `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The environment a piece's services run with: what loom would give the piece, PATH with its bins first. */
function serviceEnv(env: NodeJS.ProcessEnv, rec: PieceRecord): Record<string, string> {
  const bin = managedBinDir(env)!;
  const own = pieceEnvFor(join(bin, `loom-${rec.name}`), env);
  const keys = ['LOOM_PIECE_NAME', 'LOOM_PIECE_HOME', ...rec.loom.settings.map((s) => s.name)];
  const out: Record<string, string> = {};
  for (const k of keys) if (own[k] !== undefined) out[k] = own[k] as string;
  out.PATH = [bin, ...(own.PATH ?? '').split(delimiter).filter(Boolean)].join(delimiter);
  if (env.LOOM_HOME) out.LOOM_HOME = env.LOOM_HOME;
  return out;
}

export interface ServicesResult {
  /** Units now running. */
  started: string[];
  /** What couldn't be done, in words for the owner. */
  notes: string[];
}

/**
 * Make the units match the record: write (or rewrite) each declared one and
 * (re)start it, and stop and delete the ones it no longer declares. `rec`
 * undefined means the piece is gone. `restart` restarts units that were
 * already there (an update, a rollback, new settings).
 */
export function syncServices(env: NodeJS.ProcessEnv, name: string, rec: PieceRecord | undefined, restart = true): ServicesResult {
  const result: ServicesResult = { started: [], notes: [] };
  const dir = unitDir(env);
  const root = piecesRoot(env);
  const wanted = rec?.loom.services ?? [];
  const prefix = `loom-piece-${name}-`;
  const existing = (() => { try { return dir ? readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.service')) : []; } catch { return []; } })();
  if (!wanted.length && !existing.length) return result;
  if (!dir || !root || !hasSystemd(env)) {
    if (wanted.length) {
      result.notes.push(`There's no user systemd here, so loom can't run ${name}'s services. Start them by hand: ${wanted.map((s) => s.argv.join(' ')).join('; ')}`);
    }
    return result;
  }
  mkdirSync(dir, { recursive: true });
  const keep = new Set(wanted.map((s) => unitName(name, s.name)));
  for (const f of existing.filter((x) => !keep.has(x))) {
    systemctl(env, 'disable', '--now', f);
    rmSync(join(dir, f), { force: true });
  }
  if (rec && wanted.length) {
    const home = join(root, name);
    const envFile = join(home, 'service.env');
    writeFileSync(envFile, Object.entries(serviceEnv(env, rec)).map(([k, v]) => envLine(k, v)).join('\n') + '\n', { mode: 0o600 });
    const bin = managedBinDir(env)!;
    for (const s of wanted) {
      const unit = unitName(name, s.name);
      // A program the piece ships is run from loom's bin dir, by path.
      const [cmd, ...rest] = s.argv;
      const exe = rec.bins.includes(cmd) ? join(bin, cmd) : cmd;
      writeFileSync(join(dir, unit), [
        '# Written by loom for the managed piece ' + name + ' (docs/specs/pieces-install.md). Edits are overwritten.',
        '[Unit]',
        `Description=loom piece ${name}: ${s.name}`,
        '',
        '[Service]',
        `WorkingDirectory=${home}`,
        `EnvironmentFile=${envFile}`,
        `ExecStart=${[exe, ...rest].map(word).join(' ')}`,
        'Restart=on-failure',
        'RestartSec=5',
        // A supervisor whose children are meant to outlive its restart (loom-box's houses).
        ...(s.keepChildren ? ['KillMode=process'] : []),
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'));
    }
    systemctl(env, 'daemon-reload');
    for (const s of wanted) {
      const unit = unitName(name, s.name);
      const wasOn = existing.includes(unit);
      const r = wasOn && restart ? systemctl(env, 'restart', unit) : systemctl(env, 'enable', '--now', unit);
      if (r.ok) result.started.push(unit);
      else result.notes.push(`${unit} didn't start: ${r.out.split('\n').pop() ?? ''}`);
    }
  } else {
    systemctl(env, 'daemon-reload');
  }
  return result;
}
