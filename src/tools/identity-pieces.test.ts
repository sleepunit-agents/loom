import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIdentity, IDENTITY_PIECES, IDENTITY_CORE_BUDGET_BYTES } from './identity.js';
import { run as wake } from '../cli/wake.js';

vi.mock('../backends/salience.js', () => ({ digestForContext: () => 'TOP-OF-MIND\n' + 'd'.repeat(4774) }));
vi.mock('../backends/episodes.js', () => ({
  tapeForContext: (_: string, opts: { onlyConversation?: string | null }) => `TAPE:${opts.onlyConversation ?? 'all'}\n` + 't'.repeat(6350),
  heldFromEnv: () => 'cv-held',
}));

describe('identity core and pieces', () => {
  let dir: string;
  const load = (pieces?: string | string[]) => loadIdentity(dir, 'test', 'claude-code', 'test-model', 'retro', undefined, '/not-default', 'cv-held', pieces);
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-pieces-'));
    for (const sub of ['harnesses', 'models', 'roles', 'projects', 'memories', 'clients']) await mkdir(join(dir, sub));
    // Art's measured November 11 section sizes; text is synthetic, never rewritten or capped.
    await writeFile(join(dir, 'IDENTITY.md'), 'CREED\n' + 'c'.repeat(8056));
    await writeFile(join(dir, 'preferences.md'), 'PREFERENCES\n' + 'p'.repeat(9230));
    await writeFile(join(dir, 'self-model.md'), 'SELF-MODEL\n' + 's'.repeat(17760));
    await writeFile(join(dir, 'harnesses/claude-code.md'), 'HARNESS\n' + 'h'.repeat(15233));
    await writeFile(join(dir, 'models/test-model.md'), 'MODEL\n' + 'm'.repeat(2593));
    await writeFile(join(dir, 'roles/retro.md'), 'RETRO PLAYBOOK');
    await writeFile(join(dir, 'projects/test.md'), 'PROJECT BRIEF');
    await writeFile(join(dir, 'memories/INDEX.md'), '- [project] LEGACY MEMORY');
    await writeFile(join(dir, 'clients/claude-code.md'), '## Runtime: Test\nCLIENT RESTRICTIONS');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('keeps measured Art core under budget with verbatim core and requested mode/project', async () => {
    const core = await load();
    expect(Buffer.byteLength(core)).toBeLessThan(IDENTITY_CORE_BUDGET_BYTES);
    expect(core).toContain('CREED\n' + 'c'.repeat(8056));
    expect(core).toContain('PREFERENCES\n' + 'p'.repeat(9230));
    for (const text of ['TOP-OF-MIND', 'RETRO PLAYBOOK', 'PROJECT BRIEF', '# Pieces']) expect(core).toContain(text);
    for (const text of ['# Self-Model', '# Harness:', '# Model:', '# Last 24h', '# Memories', 'CLIENT RESTRICTIONS']) expect(core).not.toContain(text);
    for (const [name, when] of Object.entries(IDENTITY_PIECES)) expect(core).toContain(`- ${name} — load ${when}`);
  });

  it('retrieves every indexed piece, containing only its sections', async () => {
    const markers = { 'self-model': 'SELF-MODEL', harness: 'HARNESS', model: 'MODEL\n', 'last-24h': 'TAPE:cv-held', memories: 'LEGACY MEMORY' };
    for (const name of Object.keys(IDENTITY_PIECES) as (keyof typeof markers)[]) {
      const piece = await load(name);
      expect(piece).toContain(markers[name]);
      for (const text of ['# Identity', '# Preferences', '# Top of Mind', '# Mode:', '# Project:', '# Pieces']) expect(piece).not.toContain(text);
    }
    expect(await load('harness')).toContain('CLIENT RESTRICTIONS');
  });

  it('supports multiple pieces and all without duplicating sections', async () => {
    const selected = await load(['self-model', 'model', 'model']);
    expect(selected).toContain('SELF-MODEL');
    expect(selected.match(/# Model:/g)).toHaveLength(1);
    expect(selected).not.toContain('HARNESS');
    const all = await load('all');
    for (const text of ['CREED', 'PREFERENCES', 'TOP-OF-MIND', 'SELF-MODEL', 'HARNESS', 'MODEL\n', 'TAPE:cv-held', 'LEGACY MEMORY', 'RETRO PLAYBOOK', 'PROJECT BRIEF', 'CLIENT RESTRICTIONS']) expect(all).toContain(text);
    expect(all).not.toContain('# Pieces');
    const headings = ['# Identity', '# Preferences', '# Last 24h', '# Top of Mind', '# Self-Model', '# Mode:', '# Project:', '# Harness:', '# Model:', '# Memories', '## Runtime:'];
    const positions = headings.map(h => all.indexOf(h));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('rejects unknown pieces and treats an explicit empty selection as no sections', async () => {
    expect(await load('../secret')).toBe('Invalid identity piece: ../secret');
    expect(await load([])).toBe('');
  });

  it('keeps loom wake full, including the scoped tape and adapter', async () => {
    let stdout = '';
    const code = await wake(['--context-dir', dir, '--client', 'claude-code', '--model', 'test-model'], {
      stdout: s => { stdout += s; }, stderr: () => {}, env: {}, stdin: process.stdin, stdinIsTTY: false,
    });
    expect(code).toBe(0);
    for (const text of ['CREED', 'SELF-MODEL', 'HARNESS', 'MODEL\n', 'TAPE:cv-held', 'CLIENT RESTRICTIONS']) expect(stdout).toContain(text);
    expect(stdout).not.toContain('# Pieces');
  });
});
