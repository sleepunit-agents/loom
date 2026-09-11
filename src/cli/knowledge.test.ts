import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom knowledge', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-kn-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('shows help and exits 0 on --help', async () => {
    const { stdout, code } = await runCliCaptured(
      ['knowledge', '--help', '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/write|recall|maintain/);
  });

  it('returns exit 2 for unknown knowledge subcommand', async () => {
    const { stderr, code } = await runCliCaptured(
      ['knowledge', 'bogus', '--context-dir', tempDir],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown knowledge subcommand/);
  });

  describe('write', () => {
    it('writes a page and prints success', async () => {
      const { stdout, code } = await runCliCaptured([
        'knowledge', 'write',
        '--title', 'Rings Module',
        '--domain', 'music/eurorack',
        '--body', 'Physical modelling resonator.',
        '--citation', JSON.stringify({
          claim: 'Rings is a resonator',
          source_kind: 'web',
          source_locator: 'https://mutable-instruments.net/modules/rings/',
          excerpt: 'Rings resonator module.',
        }),
        '--context-dir', tempDir,
      ]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/rings-module/);
      expect(stdout).toMatch(/sourced/i);
    });

    it('writes when --context-dir precedes the subcommand (t-665)', async () => {
      // The help text calls --context-dir global. It used to be honoured
      // only AFTER the subcommand; in front of it the process fell through
      // to the MCP stdio server, read an empty stdin and exited 0 having
      // written nothing. Assert the page is really there, not just exit 0
      // — exit 0 was exactly what the broken form returned.
      const write = await runCliCaptured([
        '--context-dir', tempDir,
        'knowledge', 'write',
        '--slug', 'flag-first',
        '--title', 'Flag First',
        '--domain', 'test/dispatch',
        '--body', 'written through the flag-first form',
        '--citation', JSON.stringify({
          claim: 'flag-first writes',
          source_kind: 'web',
          source_locator: 'https://example.invalid/t-665',
          excerpt: 'flag-first writes',
        }),
      ]);
      expect(write.code).toBe(0);
      expect(write.stdout).toMatch(/flag-first/);

      const read = await runCliCaptured(
        ['knowledge', 'recall', 'flag-first form', '--context-dir', tempDir, '--json'],
      );
      expect(read.code).toBe(0);
      const pages = JSON.parse(read.stdout) as Array<{ slug: string }>;
      expect(pages.map((pg) => pg.slug)).toContain('flag-first');
    });

    it('rejects an invalid write in the flag-first position (t-665)', async () => {
      // The same argv minus the citation. The broken form exited 0 here
      // too: it never reached validation at all.
      const { code } = await runCliCaptured([
        '--context-dir', tempDir,
        'knowledge', 'write',
        '--title', 'No Citation',
        '--domain', 'test/dispatch',
        '--body', 'no citation supplied',
      ]);
      expect(code).not.toBe(0);
    });

    it('marks page provisional with conversation-only citation', async () => {
      const { stdout, code } = await runCliCaptured([
        'knowledge', 'write',
        '--title', 'Session Note',
        '--domain', 'music',
        '--body', 'We discovered a great patch.',
        '--citation', JSON.stringify({
          claim: 'great patch',
          source_kind: 'conversation',
          source_locator: 'session/abc',
          excerpt: 'sounds amazing',
        }),
        '--context-dir', tempDir,
      ]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/provisional/i);
    });

    it('returns error when citation is missing', async () => {
      const { stdout, code } = await runCliCaptured([
        'knowledge', 'write',
        '--title', 'Missing Citations',
        '--domain', 'test',
        '--body', 'Some body.',
        '--context-dir', tempDir,
      ]);
      expect(code).toBe(1);
      expect(stdout).toMatch(/Error/i);
      expect(stdout).toMatch(/citation/i);
    });

    it('emits JSON on --json', async () => {
      const { stdout, code } = await runCliCaptured([
        'knowledge', 'write',
        '--title', 'JSON Page',
        '--domain', 'test',
        '--body', 'Content.',
        '--citation', JSON.stringify({
          claim: 'a claim',
          source_kind: 'web',
          source_locator: 'https://example.com',
          excerpt: 'an excerpt',
        }),
        '--context-dir', tempDir,
        '--json',
      ]);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty('slug');
      expect(parsed).toHaveProperty('title');
    });

    it('--json with conversation-only citation stores page as provisional (§E1 gate)', async () => {
      const { code } = await runCliCaptured([
        'knowledge', 'write',
        '--title', 'Conversation JSON Note',
        '--domain', 'test',
        '--body', 'A distilled conversation insight.',
        '--citation', JSON.stringify({
          claim: 'session insight',
          source_kind: 'conversation',
          source_locator: 'session/abc',
          excerpt: 'we discussed this',
        }),
        '--context-dir', tempDir,
        '--json',
      ]);
      expect(code).toBe(0);

      // Read the stored page back and verify sourcing = provisional
      const { stdout: recallOut, code: recallCode } = await runCliCaptured([
        'knowledge', 'recall', 'Conversation JSON Note',
        '--context-dir', tempDir,
        '--json',
      ]);
      expect(recallCode).toBe(0);
      const pages = JSON.parse(recallOut);
      expect(pages).toHaveLength(1);
      expect(pages[0].sourcing).toBe('provisional');
    });

    it('--json with no citations returns exit 1', async () => {
      const { stderr, code } = await runCliCaptured([
        'knowledge', 'write',
        '--title', 'No Citations JSON',
        '--domain', 'test',
        '--body', 'Body without citations.',
        '--context-dir', tempDir,
        '--json',
      ]);
      expect(code).toBe(1);
      expect(stderr).toMatch(/citation/i);
    });
  });

  describe('recall', () => {
    it('returns no-results message on empty store', async () => {
      const { stdout, code } = await runCliCaptured(
        ['knowledge', 'recall', 'anything', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/No knowledge pages found/);
    });

    it('finds a page after writing it', async () => {
      // Write a page first
      await runCliCaptured([
        'knowledge', 'write',
        '--title', 'Mutable Rings',
        '--domain', 'music/eurorack',
        '--body', 'Physical modelling resonator module.',
        '--citation', JSON.stringify({
          claim: 'Rings',
          source_kind: 'web',
          source_locator: 'https://mutable-instruments.net',
          excerpt: 'resonator',
        }),
        '--context-dir', tempDir,
      ]);

      const { stdout, code } = await runCliCaptured(
        ['knowledge', 'recall', 'resonator', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/Mutable Rings/);
    });

    it('emits JSON on --json', async () => {
      const { stdout, code } = await runCliCaptured(
        ['knowledge', 'recall', '--context-dir', tempDir, '--json'],
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  describe('maintain', () => {
    it('returns a health report', async () => {
      const { stdout, code } = await runCliCaptured(
        ['knowledge', 'maintain', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/Knowledge maintain report/);
      expect(stdout).toMatch(/Total active pages.*0/);
    });
  });
  describe('subcommand --help', () => {
    it('prints usage instead of an Unknown option error', async () => {
      const { stdout, code } = await runCliCaptured(
        ['knowledge', 'maintain', '--help', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/Usage: loom knowledge/);
    });
  });
});
