import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, access, readFile, writeFile, lstat, readlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { CURRENT_STACK_VERSION, STACK_VERSION_FILE } from '../config.js';

describe('loom bootstrap', () => {
  let tempDir: string;

  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-boot-')); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('runs flag-driven when all required flags are provided', async () => {
    const { stdout, code } = await runCliCaptured([
      'bootstrap',
      '--name', 'sage',
      '--purpose', 'Help me code',
      '--voice', 'Direct, terse',
      '--context-dir', tempDir,
    ]);
    expect(code).toBe(0);
    await access(join(tempDir, 'IDENTITY.md'));
    await access(join(tempDir, 'preferences.md'));
    await access(join(tempDir, 'self-model.md'));
    expect(stdout.length).toBeGreaterThan(0);
  });

  it('accepts --user and writes it into the identity', async () => {
    const { code } = await runCliCaptured([
      'bootstrap',
      '--user', 'Jonathan',
      '--name', 'sage',
      '--purpose', 'Help me code',
      '--voice', 'Direct, terse',
      '--context-dir', tempDir,
    ]);
    expect(code).toBe(0);
    const identity = await readFile(join(tempDir, 'IDENTITY.md'), 'utf-8');
    expect(identity).toContain('## Working with Jonathan');
  });

  it('errors instead of silently dropping --user when the other flags are missing', async () => {
    const { code } = await runCliCaptured([
      'bootstrap', '--user', 'Jonathan', '--context-dir', tempDir,
    ]);
    expect(code).toBe(2);
  });

  it('carries user through piped JSON', async () => {
    const payload = JSON.stringify({
      user: 'Jonathan', name: 'oak', purpose: 'p', voice: 'v',
    });
    const { code } = await runCliCaptured(
      ['bootstrap', '--context-dir', tempDir],
      { stdin: payload },
    );
    expect(code).toBe(0);
    const identity = await readFile(join(tempDir, 'IDENTITY.md'), 'utf-8');
    expect(identity).toContain('## Working with Jonathan');
  });

  it('reads params from piped JSON on stdin', async () => {
    const payload = JSON.stringify({
      name: 'oak', purpose: 'p', voice: 'v', clients: ['claude-code'],
    });
    const { code } = await runCliCaptured(
      ['bootstrap', '--context-dir', tempDir],
      { stdin: payload },
    );
    expect(code).toBe(0);
    await access(join(tempDir, 'IDENTITY.md'));
  });

  it('returns exit 2 when required flags are missing and stdin is empty (TTY simulated)', async () => {
    const { code } = await runCliCaptured(
      ['bootstrap', '--context-dir', tempDir],
    );
    expect(code).not.toBe(0);
  });

  it('emits structured result on --json', async () => {
    const { stdout, code } = await runCliCaptured([
      'bootstrap',
      '--name', 'wren', '--purpose', 'p', '--voice', 'v',
      '--context-dir', tempDir, '--json',
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('contextDir');
    expect(parsed).toHaveProperty('wrote');
    expect(parsed.wrote).toEqual(expect.arrayContaining([
      expect.stringMatching(/IDENTITY\.md$/),
    ]));
  });

  it('exits 1 when the stack version stamp is ahead of this build', async () => {
    await writeFile(join(tempDir, STACK_VERSION_FILE), `${CURRENT_STACK_VERSION + 1}\n`);
    const { stderr, code } = await runCliCaptured([
      'bootstrap',
      '--name', 'rook', '--purpose', 'p', '--voice', 'v',
      '--context-dir', tempDir,
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Upgrade loom/);
  });

  it('rejects a reserved name with a clear error', async () => {
    const { stderr, code } = await runCliCaptured([
      'bootstrap',
      '--name', 'current',
      '--purpose', 'p',
      '--voice', 'v',
      '--context-dir', tempDir,
    ]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/reserved/);
  });

  it('rejects an uppercase name', async () => {
    const { stderr, code } = await runCliCaptured([
      'bootstrap',
      '--name', 'Agent',
      '--purpose', 'p',
      '--voice', 'v',
      '--context-dir', tempDir,
    ]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/lowercase/);
  });
});

describe('loom bootstrap — default symlink provisioning', () => {
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'loom-boot-home-'));
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('creates default symlink when bootstrapping under the loom config root', async () => {
    const loomRoot = join(fakeHome, '.config', 'loom');
    await mkdir(loomRoot, { recursive: true });
    const agentDir = join(loomRoot, 'myagent');
    await mkdir(agentDir, { recursive: true }); // must exist for assertStackVersionCompatible

    const { code } = await runCliCaptured(
      ['bootstrap', '--name', 'myagent', '--purpose', 'Test agent', '--voice', 'Terse',
       '--context-dir', agentDir],
      { env: { HOME: fakeHome } },
    );

    expect(code).toBe(0);
    await access(join(agentDir, 'IDENTITY.md'));

    const defaultLink = join(loomRoot, 'default');
    const s = await lstat(defaultLink);
    expect(s.isSymbolicLink()).toBe(true);
    const target = await readlink(defaultLink);
    expect(target).toBe(agentDir);
  });

  it('does not create default symlink when agent dir is outside the loom config root', async () => {
    // outsideDir is under /tmp — not under fakeHome/.config/loom/
    const outsideDir = await mkdtemp(join(tmpdir(), 'loom-outside-'));
    try {
      // outsideDir already exists (mkdtemp creates it) so assertStackVersionCompatible passes
      await runCliCaptured(
        ['bootstrap', '--name', 'art', '--purpose', 'p', '--voice', 'v',
         '--context-dir', outsideDir],
        { env: { HOME: fakeHome } },
      );
      // default symlink should NOT exist since outsideDir is not under loom root
      const defaultLink = join(fakeHome, '.config', 'loom', 'default');
      await expect(lstat(defaultLink)).rejects.toThrow();
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing default symlink', async () => {
    const loomRoot = join(fakeHome, '.config', 'loom');
    await mkdir(loomRoot, { recursive: true });
    const existingTarget = join(loomRoot, 'existing');
    await mkdir(existingTarget, { recursive: true });
    const defaultLink = join(loomRoot, 'default');
    const { symlink } = await import('node:fs/promises');
    await symlink(existingTarget, defaultLink);

    const newAgent = join(loomRoot, 'newagent');
    await mkdir(newAgent, { recursive: true }); // must exist for assertStackVersionCompatible
    await runCliCaptured(
      ['bootstrap', '--name', 'newagent', '--purpose', 'p', '--voice', 'v',
       '--context-dir', newAgent],
      { env: { HOME: fakeHome } },
    );

    // default symlink should still point to the original target
    const target = await readlink(defaultLink);
    expect(target).toBe(existingTarget);
  });
});
