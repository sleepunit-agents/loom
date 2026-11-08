/**
 * loom doctor — read-only environment probe. Reports node version
 * compatibility, stack version, existing agents under
 * ~/.config/loom/*, and forward-looking git fields per agent. Never
 * writes. Exit 0 regardless of findings; health is the output, not
 * the exit code.
 */
import { parseArgs } from 'node:util';
import { readdir, readFile, stat, lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { extractGlobalFlags } from './args.js';
import type { IOStreams } from './io.js';
import { renderJson } from './io.js';
import { CURRENT_STACK_VERSION, resolveDefaultContextPath } from '../config.js';

const USAGE = `Usage: loom doctor [options]

Probes the loom environment. Read-only; exits 0 regardless of findings.

Options:
  --json    Machine-readable output
  --help    Show this help
`;

interface GitState {
  initialized: boolean;
  hasRemote: boolean;
  dirty: boolean;
  gitignorePresent: boolean;
}

interface AgentReport {
  name: string;
  path: string;
  hasIdentity: boolean;
  hasMemoriesDb: boolean;
  git: GitState;
}

interface DefaultStatus {
  exists: boolean;
  isSymlink: boolean;
  target?: string;
  dangling?: boolean;
  empty?: boolean;
}

interface DoctorReport {
  nodeOk: boolean;
  nodeVersion: string;
  stackVersionOk: boolean;
  contextDirResolved: string;
  agentsRoot: string;
  existingAgents: AgentReport[];
  defaultStatus: DefaultStatus;
  defaultOk: boolean;
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function probeGit(agentDir: string): Promise<GitState> {
  const dotGit = join(agentDir, '.git');
  const initialized = await fileExists(dotGit);
  const gitignorePresent = await fileExists(join(agentDir, '.gitignore'));
  return {
    initialized,
    hasRemote: false,
    dirty: false,
    gitignorePresent,
  };
}

async function probeDefault(root: string): Promise<DefaultStatus> {
  const defaultPath = join(root, 'default');
  let s;
  try {
    s = await lstat(defaultPath);
  } catch {
    return { exists: false, isSymlink: false };
  }
  if (s.isSymbolicLink()) {
    const target = await readlink(defaultPath);
    try {
      await stat(defaultPath); // follows the symlink; throws if dangling
      const empty = !(await fileExists(join(defaultPath, 'IDENTITY.md')));
      return { exists: true, isSymlink: true, target, dangling: false, empty };
    } catch {
      return { exists: true, isSymlink: true, target, dangling: true };
    }
  }
  // A real directory named "default" — should be a symlink per the spec
  const empty = !(await fileExists(join(defaultPath, 'IDENTITY.md')));
  return { exists: true, isSymlink: false, empty };
}

async function probeAgents(home: string): Promise<{ root: string; agents: AgentReport[]; defaultStatus: DefaultStatus }> {
  const root = join(home, '.config', 'loom');
  const agents: AgentReport[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    const defaultStatus = await probeDefault(root);
    return { root, agents, defaultStatus };
  }
  for (const name of entries.sort()) {
    if (name === 'default') continue; // handled via probeDefault
    const p = join(root, name);
    let s;
    try { s = await stat(p); } catch { continue; }
    if (!s.isDirectory()) continue;
    agents.push({
      name,
      path: p,
      hasIdentity: await fileExists(join(p, 'IDENTITY.md')),
      hasMemoriesDb: await fileExists(join(p, 'memories.db')),
      git: await probeGit(p),
    });
  }
  const defaultStatus = await probeDefault(root);
  return { root, agents, defaultStatus };
}

function defaultIsOk(ds: DefaultStatus): boolean {
  if (!ds.exists) return false;
  if (!ds.isSymlink) return false; // real dir is not ok — must be a symlink
  if (ds.dangling) return false;
  if (ds.empty) return false;
  return true;
}

function nodeOk(version: string): boolean {
  const m = version.match(/^v(\d+)\./);
  return m !== null && Number(m[1]) >= 20;
}

async function probeStackVersion(contextDir: string): Promise<boolean> {
  const file = join(contextDir, 'LOOM_STACK_VERSION');
  try {
    const body = (await readFile(file, 'utf-8')).trim();
    const v = Number(body);
    return Number.isInteger(v) && v <= CURRENT_STACK_VERSION;
  } catch {
    return true;
  }
}

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        json: { type: 'boolean' },
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

  const home = io.env.HOME ?? process.env.HOME ?? '';
  const contextDir = global.contextDir ?? io.env.LOOM_CONTEXT_DIR ?? resolveDefaultContextPath(home);
  const { root, agents, defaultStatus } = await probeAgents(home);

  const report: DoctorReport = {
    nodeOk: nodeOk(process.version),
    nodeVersion: process.version,
    stackVersionOk: await probeStackVersion(contextDir),
    contextDirResolved: contextDir,
    agentsRoot: root,
    existingAgents: agents,
    defaultStatus,
    defaultOk: defaultIsOk(defaultStatus),
  };

  const json = Boolean(parsed.values.json) || Boolean(global.json);
  if (json) {
    renderJson(io, report);
    return 0;
  }

  const lines: string[] = [];
  lines.push(`node:        ${report.nodeVersion}${report.nodeOk ? '' : '  (unsupported — need ≥ 20)'}`);
  lines.push(`stack:       ${report.stackVersionOk ? 'compatible' : 'incompatible'}`);
  lines.push(`context dir: ${report.contextDirResolved}`);
  lines.push(`agents root: ${report.agentsRoot}`);

  const ds = report.defaultStatus;
  if (!ds.exists) {
    lines.push('default:     missing  [FAIL — run `loom bootstrap` to create an agent and set up the default pointer]');
  } else if (!ds.isSymlink) {
    lines.push('default:     real directory (should be a symlink)  [FAIL]');
  } else if (ds.dangling) {
    lines.push(`default:     ${ds.target} (dangling — target does not exist)  [FAIL]`);
  } else if (ds.empty) {
    lines.push(`default:     -> ${ds.target} (no IDENTITY.md)  [FAIL]`);
  } else {
    lines.push(`default:     -> ${ds.target}  [ok]`);
  }

  if (report.existingAgents.length === 0) {
    lines.push('agents:      (none)');
  } else {
    lines.push(`agents:      ${report.existingAgents.length}`);
    for (const a of report.existingAgents) {
      const flags: string[] = [];
      if (a.hasIdentity) flags.push('identity');
      if (a.hasMemoriesDb) flags.push('memories.db');
      if (a.git.initialized) flags.push('git');
      lines.push(`  - ${a.name} (${flags.join(', ') || 'empty'})`);
    }
  }
  io.stdout(lines.join('\n') + '\n');
  return 0;
}
