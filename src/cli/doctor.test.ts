import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './doctor.js';
import type { IOStreams } from './io.js';

function mkIo(env: Record<string, string>): { io: IOStreams; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: IOStreams = {
    stdin: process.stdin,
    stdinIsTTY: false,
    stdout: (s) => { out.push(s); },
    stderr: (s) => { err.push(s); },
    env,
  };
  return { io, out, err };
}

describe('loom doctor', () => {
  let work: string;
  beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'loom-doctor-')); });
  afterEach(async () => { await rm(work, { recursive: true, force: true }); });

  it('reports empty existingAgents in a fresh HOME', async () => {
    const { io, out } = mkIo({ HOME: work });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.existingAgents).toEqual([]);
    expect(typeof parsed.nodeOk).toBe('boolean');
    expect(parsed.nodeOk).toBe(true);
    expect(parsed.stackVersionOk).toBe(true);
  });

  it('discovers agents under ~/.config/loom/*', async () => {
    const agentDir = join(work, '.config', 'loom', 'myagent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'IDENTITY.md'), '# MyAgent\n', 'utf-8');

    const { io, out } = mkIo({ HOME: work });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.existingAgents).toHaveLength(1);
    const [agent] = parsed.existingAgents;
    expect(agent.name).toBe('myagent');
    expect(agent.hasIdentity).toBe(true);
    expect(agent.hasMemoriesDb).toBe(false);
    expect(agent.git.initialized).toBe(false);
    expect(agent.git.hasRemote).toBe(false);
    expect(agent.git.dirty).toBe(false);
    expect(agent.git.gitignorePresent).toBe(false);
  });

  it('reports git.initialized=true when a .git dir is present', async () => {
    const agentDir = join(work, '.config', 'loom', 'myagent');
    await mkdir(join(agentDir, '.git'), { recursive: true });
    await writeFile(join(agentDir, 'IDENTITY.md'), '# MyAgent\n', 'utf-8');
    await writeFile(join(agentDir, '.gitignore'), 'memories.db\n', 'utf-8');

    const { io, out } = mkIo({ HOME: work });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.existingAgents[0].git.initialized).toBe(true);
    expect(parsed.existingAgents[0].git.gitignorePresent).toBe(true);
  });

  it('reports stackVersionOk=true when LOOM_STACK_VERSION=2', async () => {
    const contextDir = join(work, 'ctx');
    await mkdir(contextDir, { recursive: true });
    await writeFile(join(contextDir, 'LOOM_STACK_VERSION'), '2\n', 'utf-8');

    const { io, out } = mkIo({ HOME: work, LOOM_CONTEXT_DIR: contextDir });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.stackVersionOk).toBe(true);
  });

  it('human-readable output lists each agent on its own line', async () => {
    const agentDir = join(work, '.config', 'loom', 'myagent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'IDENTITY.md'), '# MyAgent\n', 'utf-8');

    const { io, out } = mkIo({ HOME: work });
    const code = await run([], io);
    expect(code).toBe(0);
    const joined = out.join('');
    expect(joined).toMatch(/myagent/);
    expect(joined).toMatch(/node/i);
  });

  it('reports defaultStatus.exists=false when default does not exist', async () => {
    const { io, out } = mkIo({ HOME: work });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.defaultStatus).toBeDefined();
    expect(parsed.defaultStatus.exists).toBe(false);
    expect(parsed.defaultOk).toBe(false);
  });

  it('reports defaultOk=false when default is a real dir (not a symlink)', async () => {
    const defaultDir = join(work, '.config', 'loom', 'default');
    await mkdir(defaultDir, { recursive: true });
    await writeFile(join(defaultDir, 'IDENTITY.md'), '# Default\n', 'utf-8');

    const { io, out } = mkIo({ HOME: work });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.defaultStatus.exists).toBe(true);
    expect(parsed.defaultStatus.isSymlink).toBe(false);
    expect(parsed.defaultOk).toBe(false);
  });

  it('reports defaultOk=true when default is a valid symlink with IDENTITY.md', async () => {
    const agentDir = join(work, '.config', 'loom', 'art');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'IDENTITY.md'), '# Art\n', 'utf-8');
    const defaultLink = join(work, '.config', 'loom', 'default');
    const { symlink } = await import('node:fs/promises');
    await symlink(agentDir, defaultLink);

    const { io, out } = mkIo({ HOME: work });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.defaultStatus.isSymlink).toBe(true);
    expect(parsed.defaultStatus.target).toBe(agentDir);
    expect(parsed.defaultStatus.dangling).toBe(false);
    expect(parsed.defaultStatus.empty).toBe(false);
    expect(parsed.defaultOk).toBe(true);
  });

  it('reports dangling=true when default symlink points to a nonexistent target', async () => {
    const loomRoot = join(work, '.config', 'loom');
    await mkdir(loomRoot, { recursive: true });
    const defaultLink = join(loomRoot, 'default');
    const { symlink } = await import('node:fs/promises');
    await symlink('/nonexistent/path', defaultLink);

    const { io, out } = mkIo({ HOME: work });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.defaultStatus.isSymlink).toBe(true);
    expect(parsed.defaultStatus.dangling).toBe(true);
    expect(parsed.defaultOk).toBe(false);
  });

  it('reports empty=true when default symlink target has no IDENTITY.md', async () => {
    const agentDir = join(work, '.config', 'loom', 'art');
    await mkdir(agentDir, { recursive: true }); // no IDENTITY.md
    const defaultLink = join(work, '.config', 'loom', 'default');
    const { symlink } = await import('node:fs/promises');
    await symlink(agentDir, defaultLink);

    const { io, out } = mkIo({ HOME: work });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.defaultStatus.isSymlink).toBe(true);
    expect(parsed.defaultStatus.empty).toBe(true);
    expect(parsed.defaultOk).toBe(false);
  });

  it('excludes the default symlink from existingAgents', async () => {
    const agentDir = join(work, '.config', 'loom', 'art');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'IDENTITY.md'), '# Art\n', 'utf-8');
    const defaultLink = join(work, '.config', 'loom', 'default');
    const { symlink } = await import('node:fs/promises');
    await symlink(agentDir, defaultLink);

    const { io, out } = mkIo({ HOME: work });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    // 'default' should not appear in existingAgents — only 'art'
    expect(parsed.existingAgents.map((a: { name: string }) => a.name)).not.toContain('default');
    expect(parsed.existingAgents).toHaveLength(1);
    expect(parsed.existingAgents[0].name).toBe('art');
  });

  it('human-readable output flags missing default', async () => {
    const { io, out } = mkIo({ HOME: work });
    const code = await run([], io);
    expect(code).toBe(0);
    const joined = out.join('');
    expect(joined).toMatch(/default:.*FAIL/);
  });
});
