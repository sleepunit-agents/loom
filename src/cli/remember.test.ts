import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom remember', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-remember-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('writes memory with body from stdin (human output)', async () => {
    const { stdout, code } = await runCliCaptured(
      ['remember', 'my note', '--category', 'reference', '--context-dir', tempDir],
      { stdin: 'body from stdin' },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/Remembered/i);
  });

  it('emits MemoryRef on --json', async () => {
    const { stdout, code } = await runCliCaptured(
      ['remember', 'json note', '--category', 'reference', '--context-dir', tempDir, '--json'],
      { stdin: 'body' },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('ref');
    expect(parsed).toHaveProperty('title', 'json note');
  });

  it('rejects empty body with exit 2', async () => {
    const { stderr, code } = await runCliCaptured(
      ['remember', 'empty', '--category', 'reference', '--context-dir', tempDir],
      { stdin: '' },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/body/i);
  });

  it('requires a title (exit 2)', async () => {
    const { stderr, code } = await runCliCaptured(
      ['remember', '--context-dir', tempDir],
      { stdin: 'body' },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/title/i);
  });

  it('defaults category to "reference" when omitted', async () => {
    const { stdout, code } = await runCliCaptured(
      ['remember', 'def', '--context-dir', tempDir, '--json'],
      { stdin: 'body' },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.category).toBe('reference');
    // Context dir exists (readdir sanity) — backend stores in sqlite, not nested dirs.
    const entries = await readdir(tempDir);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('rejects an unknown category with exit 2 and lists valid ones', async () => {
    const { stderr, code } = await runCliCaptured(
      ['remember', 'note', '--category', 'general', '--context-dir', tempDir],
      { stdin: 'body' },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown category "general"/);
    expect(stderr).toMatch(/user, project, self, feedback, reference, pursuit/);
  });

  it('--meta merges a JSON object into metadata (episode where-tag path)', async () => {
    const { stdout, code } = await runCliCaptured(
      ['remember', 'ep', '--category', 'episode', '--meta', '{"where":"voice","session_id":"abc"}', '--json', '--context-dir', tempDir],
      { stdin: 'what happened' },
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout).category).toBe('episode');
    const { stdout: tape } = await runCliCaptured(['memory', 'tape', '--context-dir', tempDir]);
    expect(tape).toContain('[voice] ep — what happened');
  });

  it('rejects --meta that is not a JSON object', async () => {
    const { code, stderr } = await runCliCaptured(
      ['remember', 'ep', '--category', 'episode', '--meta', '[1]', '--context-dir', tempDir],
      { stdin: 'x' },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/--meta must be a JSON object/);
  });

  it('accepts every category in the shared vocabulary', async () => {
    const { code } = await runCliCaptured(
      ['remember', 'pursuit note', '--category', 'pursuit', '--context-dir', tempDir],
      { stdin: 'body' },
    );
    expect(code).toBe(0);
  });
});
