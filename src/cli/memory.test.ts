import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { remember } from '../tools/remember.js';

describe('loom memory', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-memory-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
    await remember(tempDir, { category: 'reference', title: 'alpha', content: 'a' });
    await remember(tempDir, { category: 'reference', title: 'beta',  content: 'b' });
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  describe('list', () => {
    it('prints entries in human format', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'list', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/alpha/);
      expect(stdout).toMatch(/beta/);
    });

    it('emits MemoryEntry[] when --json', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'list', '--context-dir', tempDir, '--json'],
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
    });
  });

  describe('prune', () => {
    it('reports clean store when nothing expired', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'prune', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/healthy|No expired/i);
    });

    it('supports --json', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'prune', '--context-dir', tempDir, '--json'],
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty('expired');
      expect(parsed).toHaveProperty('stale');
    });
  });

  describe('recall-stats', () => {
    it('reports an empty window when nothing has been logged', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'recall-stats', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/0 searches/);
    });

    it('summarizes searches made through the CLI, including misses', async () => {
      await runCliCaptured(['recall', 'alpha', '--context-dir', tempDir]);
      await runCliCaptured(['recall', 'zzz', '--context-dir', tempDir, '--category', 'nope']);
      const { stdout, code } = await runCliCaptured(
        ['memory', 'recall-stats', '--context-dir', tempDir, '--since', '24h'],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/last 24h\): 2 searches/);
      expect(stdout).toMatch(/hit rate\s+1\/2 \(50%\)/);
      expect(stdout).toMatch(/Recent misses/);
      expect(stdout).toMatch(/"zzz"\s+\[category=nope\]/);
    });

    it('emits RecallStats with --json', async () => {
      await runCliCaptured(['recall', 'alpha', '--context-dir', tempDir]);
      const { stdout, code } = await runCliCaptured(
        ['memory', 'recall-stats', '--context-dir', tempDir, '--json'],
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toMatchObject({ since: '7d', searches: 1, hits: 1, misses: 0 });
      expect(parsed).toHaveProperty('medianLatencyMs');
      expect(parsed).toHaveProperty('medianTopScore');
      expect(parsed).toHaveProperty('recentMisses');
    });

    it('exits 2 on a bad --since', async () => {
      const { stderr, code } = await runCliCaptured(
        ['memory', 'recall-stats', '--context-dir', tempDir, '--since', 'yesterday'],
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/--since/);
    });
  });

  it('returns exit 2 for unknown memory subcommand', async () => {
    const { stderr, code } = await runCliCaptured(
      ['memory', 'bogus', '--context-dir', tempDir],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/list|prune/);
  });

  describe('capture-propose queue', () => {
    it('propose stages a draft that proposals lists but list does NOT show', async () => {
      const proposed = await runCliCaptured(
        ['memory', 'propose', '--context-dir', tempDir,
          '--category', 'project', '--title', 'Drafted', '--content', 'a zorblax note', '--source', 'lane'],
      );
      expect(proposed.code).toBe(0);
      expect(proposed.stdout).toMatch(/Proposal staged/);

      // proposals lists the draft
      const queue = await runCliCaptured(['memory', 'proposals', '--context-dir', tempDir]);
      expect(queue.code).toBe(0);
      expect(queue.stdout).toMatch(/Drafted/);
      expect(queue.stdout).toMatch(/\[lane\]/);

      // but memory list does NOT (invisibility invariant)
      const listed = await runCliCaptured(['memory', 'list', '--context-dir', tempDir]);
      expect(listed.stdout).not.toMatch(/Drafted/);
      expect(listed.stdout).toMatch(/alpha/);
    });

    it('propose --json emits a ProposalRef; proposals --json emits the rows', async () => {
      const proposed = await runCliCaptured(
        ['memory', 'propose', '--context-dir', tempDir, '--json',
          '--category', 'self', '--title', 'J', '--content', 'json body'],
      );
      const ref = JSON.parse(proposed.stdout);
      expect(ref).toHaveProperty('id');
      expect(ref).toHaveProperty('uuid');

      const queue = await runCliCaptured(['memory', 'proposals', '--context-dir', tempDir, '--json']);
      const rows = JSON.parse(queue.stdout);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows[0].id).toBe(ref.id);
    });

    it('propose without required flags exits 2', async () => {
      const { code, stderr } = await runCliCaptured(
        ['memory', 'propose', '--context-dir', tempDir, '--title', 'no content'],
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/--category, --title, and --content/);
    });

    it('ratify promotes a proposal into a real, listable memory and clears the queue', async () => {
      const proposed = await runCliCaptured(
        ['memory', 'propose', '--context-dir', tempDir, '--json',
          '--category', 'project', '--title', 'Promote', '--content', 'a flubber note'],
      );
      const { id } = JSON.parse(proposed.stdout);

      const ratified = await runCliCaptured(['memory', 'ratify', String(id), '--context-dir', tempDir]);
      expect(ratified.code).toBe(0);
      expect(ratified.stdout).toMatch(/ratified →/);

      // now it shows up in memory list, and the queue is empty
      const listed = await runCliCaptured(['memory', 'list', '--context-dir', tempDir]);
      expect(listed.stdout).toMatch(/Promote/);
      const queue = await runCliCaptured(['memory', 'proposals', '--context-dir', tempDir]);
      expect(queue.stdout).toMatch(/No pending proposals/);
    });

    it('ratify with overrides applies the edits', async () => {
      const proposed = await runCliCaptured(
        ['memory', 'propose', '--context-dir', tempDir, '--json',
          '--category', 'self', '--title', 'rough', '--content', 'rough body'],
      );
      const { id } = JSON.parse(proposed.stdout);

      await runCliCaptured(
        ['memory', 'ratify', String(id), '--context-dir', tempDir, '--title', 'polished'],
      );
      const listed = await runCliCaptured(['memory', 'list', '--context-dir', tempDir]);
      expect(listed.stdout).toMatch(/polished/);
      expect(listed.stdout).not.toMatch(/rough/);
    });

    it('ratify of an unknown id exits 3', async () => {
      const { code, stderr } = await runCliCaptured(
        ['memory', 'ratify', '9999', '--context-dir', tempDir],
      );
      expect(code).toBe(3);
      expect(stderr).toMatch(/not found/);
    });

    it('reject removes a pending proposal', async () => {
      const proposed = await runCliCaptured(
        ['memory', 'propose', '--context-dir', tempDir, '--json',
          '--category', 'self', '--title', 'discard', '--content', 'x'],
      );
      const { id } = JSON.parse(proposed.stdout);

      const rejected = await runCliCaptured(['memory', 'reject', String(id), '--context-dir', tempDir]);
      expect(rejected.code).toBe(0);
      expect(rejected.stdout).toMatch(/rejected and removed/);

      const queue = await runCliCaptured(['memory', 'proposals', '--context-dir', tempDir]);
      expect(queue.stdout).toMatch(/No pending proposals/);
    });

    it('reject of an unknown id exits 3', async () => {
      const { code, stderr } = await runCliCaptured(
        ['memory', 'reject', '9999', '--context-dir', tempDir],
      );
      expect(code).toBe(3);
      expect(stderr).toMatch(/not found/);
    });
  });
  // Regression: `loom memory recompute-salience --help` used to fall through
  // to the subcommand body and recompute — asking for help mutated the store.
  // Found by Mark (CT 113) on 2026-09-04.
  describe('subcommand --help', () => {
    it('recompute-salience --help prints usage without recomputing', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'recompute-salience', '--help', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/Usage: loom memory/);
      expect(stdout).not.toMatch(/recomputed salience/);
    });

    it('digest --help prints usage without emitting the digest', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'digest', '--help', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/Usage: loom memory/);
      expect(stdout).not.toMatch(/Top of mind/);
    });

    it('-h works the same as --help', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'recompute-salience', '-h', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/Usage: loom memory/);
    });

    it('a flag-parsing subcommand gets help too, not an Unknown option error', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'list', '--help', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/Usage: loom memory/);
    });

    it('recompute-salience rejects arguments it cannot act on', async () => {
      const { stderr, code } = await runCliCaptured(
        ['memory', 'recompute-salience', '--dry-run', '--context-dir', tempDir],
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/takes no arguments/);
    });

    it('digest rejects arguments it cannot act on', async () => {
      const { stderr, code } = await runCliCaptured(
        ['memory', 'digest', '--hours', '4', '--context-dir', tempDir],
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/takes no arguments/);
    });
  });
});
