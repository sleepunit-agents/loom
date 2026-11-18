import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { hasControlCharacter } from '../core/line-name.js';
import { NESTED_SOCKET_TARGET } from './worker-mounts.js';
import { promisify } from 'node:util';
import { z } from 'zod';
import { saysNoSecret } from './body-secrets.js';

const scope = z.enum(['system', 'user']);
const unit = z.string().max(255).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]*\.(?:service|socket|timer|target|mount|automount|swap|slice|scope|path|device)(?![\s\S])/);
const window = {
  lines: z.number().int().min(1).max(100).default(30),
  since: z.number().int().min(1).max(1440).default(60),
};
const simpleKinds = ['disk', 'memory', 'load', 'swap', 'uptime', 'boots', 'containers', 'proxmox-vms', 'proxmox-containers', 'zfs', 'zpool'] as const;
export const machineReadKinds = [...simpleKinds, 'unit-state', 'unit-journal', 'failed-units', 'restarting-units', 'worker-log'] as const;
const request = z.union([
  z.strictObject({ kind: z.enum(simpleKinds) }),
  z.strictObject({ kind: z.enum(['failed-units', 'restarting-units']), scope }),
  z.strictObject({ kind: z.literal('unit-state'), scope, unit }),
  z.strictObject({ kind: z.literal('unit-journal'), scope, unit, ...window }),
  z.strictObject({ kind: z.literal('worker-log'), ...window }),
]);

export type MachineReadRequest = z.output<typeof request>;
export type MachineReadResult = { ok: boolean; output: string };
export const machineReadOutputBytes = 16_384;

export function parseMachineRead(input: unknown): MachineReadRequest {
  const parsed = request.safeParse(input);
  if (!parsed.success) throw new TypeError('Invalid machine read kind or arguments');
  return parsed.data;
}

export function machineReadCommand(read: MachineReadRequest): [string, ...string[]] {
  switch (read.kind) {
    case 'unit-state':
      return ['/usr/bin/systemctl', '--' + read.scope, '--no-pager', 'show',
        '--property=Id,LoadState,ActiveState,SubState,Result,NRestarts,ExecMainCode,ExecMainStatus', '--', read.unit];
    case 'failed-units':
    case 'restarting-units':
      return ['/usr/bin/systemctl', '--' + read.scope, '--no-pager', '--no-legend', '--plain', 'list-units',
        '--state=' + (read.kind === 'failed-units' ? 'failed' : 'auto-restart')];
    case 'worker-log':
    case 'unit-journal': {
      const user = read.kind === 'worker-log' || read.scope === 'user';
      const units = read.kind === 'worker-log' ? ['loom-new-worker.service', 'loom-worker.service'] : [read.unit];
      return ['/usr/bin/journalctl', user ? '--user' : '--system', '--quiet', '--no-pager', '--output=short-iso',
         '--lines=' + read.lines, '--since=' + read.since + ' minutes ago',
        ...units.map(name => (user ? '--user-unit=' : '--unit=') + name)];
    }
    case 'disk': return ['/usr/bin/df', '--local', '--human-readable', '--output=fstype,size,used,avail,pcent,target'];
    case 'memory': return ['/usr/bin/free', '--bytes'];
    case 'load': return ['/usr/bin/cat', '/proc/loadavg'];
    case 'swap': return ['/usr/sbin/swapon', '--show=TYPE,SIZE,USED,PRIO', '--bytes'];
    case 'uptime': return ['/usr/bin/uptime', '--pretty'];
    case 'boots': return ['/usr/bin/journalctl', '--no-pager', '--quiet', '--list-boots', '--lines=10'];
    case 'containers': return ['/usr/bin/docker', '--host=unix://' + NESTED_SOCKET_TARGET, 'ps', '--format', '{{.ID}}\t{{.Names}}\t{{.State}}'];
    case 'proxmox-vms': return ['/usr/sbin/qm', 'list'];
    case 'proxmox-containers': return ['/usr/sbin/pct', 'list'];
    case 'zpool': return ['/usr/sbin/zpool', 'status', '-x'];
    case 'zfs': return ['/usr/sbin/zfs', 'list', '-H', '-o', 'name,type,used,avail,refer'];
  }
}

const credential = /(?:\b(?:loom_|body_|gh[pousr]_|github_pat_|sk-|AKIA)[A-Za-z0-9_-]{8,}|\b(?:bearer|basic)\s+[A-Za-z0-9_+/=.:-]+|\b(?:authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key)["']?\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|:\/\/[^\s/@]+:[^\s/@]+@)/i;
const tooLarge = (): MachineReadResult => ({ ok: false, output: 'Machine read exceeds the output limit' });
type Executor = (file: string, argv: string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string }>;

const executeUnprivileged: Executor = (file, argv, options) =>
  promisify(execFile)('/usr/bin/setpriv', ['--no-new-privs', '--', file, ...argv], options);

export function offeredMachineReads(configured: readonly MachineReadRequest['kind'][]) {
  if (process.platform !== 'linux' || !process.getuid?.() || !process.geteuid?.()) return [];
  return configured.filter(kind => {
    const sample = {kind, scope: 'user', unit: 'loom-worker.service', lines: 1, since: 1} as const;
    try {
      accessSync('/usr/bin/setpriv', constants.X_OK);
      accessSync(machineReadCommand(sample)[0], constants.X_OK);
      if (kind === 'containers') accessSync(NESTED_SOCKET_TARGET, constants.W_OK);
      return true;
    } catch { return false; }
  });
}

export async function runMachineRead(input: unknown, workerToken: string, execute: Executor = executeUnprivileged): Promise<MachineReadResult> {
  const read = parseMachineRead(input);
  const uid = process.geteuid?.();
  if (process.platform !== 'linux' || uid === undefined || uid === 0 || process.getuid?.() === 0)
    return { ok: false, output: 'Machine reads require an unprivileged Linux worker' };
  if (!workerToken) return { ok: false, output: 'Worker credential unavailable' };
  const [file, ...argv] = machineReadCommand(read);
  try {
    const { stdout } = await execute(file, argv, {
      cwd: '/', shell: false, timeout: 4000, killSignal: 'SIGKILL', maxBuffer: machineReadOutputBytes, encoding: 'utf8',
      env: { HOME: '/nonexistent', LANG: 'C', PATH: '/usr/sbin:/usr/bin:/sbin:/bin', XDG_RUNTIME_DIR: '/run/user/' + uid,
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/' + uid + '/bus', SYSTEMD_COLORS: '0' },
    });
    let output = stdout.trim();

    if (read.kind === 'failed-units' || read.kind === 'restarting-units')
      output = output.split('\n').map(line => line.trim().split(/\s+/).slice(0, 4).join(' ')).join('\n');
    if (Buffer.byteLength(stdout) > machineReadOutputBytes) return tooLarge();
    output = Array.from(output).filter(ch => ch === '\n' || ch === '\t' || !hasControlCharacter(ch)).join('');
    const raw = Buffer.from(workerToken);
    const encoded = Buffer.from(raw.toString('base64'));
    try {
      if (!saysNoSecret(output, [raw, encoded]) || credential.test(output))
        return { ok: false, output: 'Machine read contains a credential' };
    } finally {
      raw.fill(0);
      encoded.fill(0);
    }
    return { ok: true, output };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return tooLarge();
    // Neither stderr nor the thrown Error is safe to send back across the worker door.
    return { ok: false, output: 'Machine read unavailable, denied, or exceeded its budget' };
  }
}
