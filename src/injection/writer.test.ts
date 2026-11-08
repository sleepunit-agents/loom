import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeManagedBlock,
  previewWrite,
  MalformedMarkersError,
} from './writer.js';

const BLOCK = `<!-- loom:start v1 harness=claude-code -->
## Persistent identity via loom

Context dir: /fake/ctx
<!-- loom:end -->
`;

const OTHER_BLOCK = `<!-- loom:start v1 harness=claude-code -->
## Updated block

Context dir: /different/ctx
<!-- loom:end -->
`;

describe('writeManagedBlock', () => {
  let dir: string;

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'loom-inject-writer-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('creates a new file containing only the block', async () => {
    const path = join(dir, 'nested', 'CLAUDE.md');
    const result = await writeManagedBlock(path, BLOCK);
    expect(result.action).toBe('created');
    expect(result.path).toBe(path);
    expect(result.bytesWritten).toBeGreaterThan(0);
    const written = await readFile(path, 'utf-8');
    expect(written).toBe(BLOCK);
  });

  it('appends when file exists without markers', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '# My notes\n\nHand-written content.\n', 'utf-8');
    const result = await writeManagedBlock(path, BLOCK);
    expect(result.action).toBe('appended');
    const written = await readFile(path, 'utf-8');
    expect(written.startsWith('# My notes\n\nHand-written content.\n')).toBe(true);
    expect(written.includes(BLOCK)).toBe(true);
    expect(written).toBe(`# My notes\n\nHand-written content.\n\n${BLOCK}`);
  });

  it('replaces content between markers and preserves outside content', async () => {
    const path = join(dir, 'CLAUDE.md');
    const existing = `# Top\n\n<!-- loom:start v1 harness=claude-code -->
## Old block

Context dir: /old
<!-- loom:end -->\n\n# Bottom\n`;
    await writeFile(path, existing, 'utf-8');
    const result = await writeManagedBlock(path, OTHER_BLOCK);
    expect(result.action).toBe('updated');
    const written = await readFile(path, 'utf-8');
    expect(written).toContain('# Top');
    expect(written).toContain('# Bottom');
    expect(written).toContain('Context dir: /different/ctx');
    expect(written).not.toContain('Context dir: /old');
  });

  it('reports no-change when an update would be byte-identical', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, `# Top\n\n${BLOCK}\n# Bottom\n`, 'utf-8');
    const result = await writeManagedBlock(path, BLOCK);
    expect(result.action).toBe('no-change');
    const written = await readFile(path, 'utf-8');
    expect(written).toBe(`# Top\n\n${BLOCK}\n# Bottom\n`);
  });

  it('second identical run is a no-change (idempotent)', async () => {
    const path = join(dir, 'CLAUDE.md');
    const first = await writeManagedBlock(path, BLOCK);
    expect(first.action).toBe('created');
    const second = await writeManagedBlock(path, BLOCK);
    expect(second.action).toBe('no-change');
  });

  it('throws MalformedMarkersError when only a start marker is present', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '<!-- loom:start v1 harness=claude-code -->\n(no end)\n', 'utf-8');
    await expect(writeManagedBlock(path, BLOCK)).rejects.toBeInstanceOf(MalformedMarkersError);
  });

  it('throws MalformedMarkersError when only an end marker is present', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '(no start)\n<!-- loom:end -->\n', 'utf-8');
    await expect(writeManagedBlock(path, BLOCK)).rejects.toBeInstanceOf(MalformedMarkersError);
  });

  it('throws MalformedMarkersError when end appears before start', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '<!-- loom:end -->\n<!-- loom:start v1 harness=claude-code -->\n', 'utf-8');
    await expect(writeManagedBlock(path, BLOCK)).rejects.toBeInstanceOf(MalformedMarkersError);
  });

  it('throws MalformedMarkersError when two start markers are present', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(
      path,
      `<!-- loom:start v1 harness=claude-code -->\nA\n<!-- loom:end -->\n<!-- loom:start v1 harness=claude-code -->\nB\n<!-- loom:end -->\n`,
      'utf-8',
    );
    await expect(writeManagedBlock(path, BLOCK)).rejects.toBeInstanceOf(MalformedMarkersError);
  });

  it('preserves file mode on update', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, `${BLOCK}`, 'utf-8');
    await chmod(path, 0o640);
    await writeManagedBlock(path, OTHER_BLOCK);
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o640);
  });

  it('removes the .loom.tmp file after successful rename', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeManagedBlock(path, BLOCK);
    await expect(stat(`${path}.loom.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ends written content with exactly one trailing newline', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeManagedBlock(path, BLOCK);
    const written = await readFile(path, 'utf-8');
    expect(written.endsWith('\n')).toBe(true);
    expect(written.endsWith('\n\n')).toBe(false);
  });

  it('does not match unrelated loom:start* comments (word boundary)', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '<!-- loom:started -->\n<!-- loom:starting-gun -->\n', 'utf-8');
    // No real start/end markers => should treat as no-markers and append.
    const result = await writeManagedBlock(path, BLOCK);
    expect(result.action).toBe('appended');
  });

  it('normalizes exactly one blank line between end marker and following content on update', async () => {
    const path = join(dir, 'CLAUDE.md');
    // BLOCK ends with \n; add one more \n to produce one blank line before "# Next section"
    const existing = `${BLOCK}\n# Next section\n`;
    await writeFile(path, existing, 'utf-8');
    const result = await writeManagedBlock(path, OTHER_BLOCK);
    expect(result.action).toBe('updated');
    const written = await readFile(path, 'utf-8');
    // The single \n after end marker is stripped and the block contributes its own trailing \n,
    // so exactly one blank line (two \n) separates end marker from "# Next section"
    expect(written).toMatch(/<!-- loom:end -->\n\n# Next section\n$/);
    // Running again should now be a no-change
    const result2 = await writeManagedBlock(path, OTHER_BLOCK);
    expect(result2.action).toBe('no-change');
  });
});

describe('previewWrite', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'loom-inject-preview-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('predicts "created" for a path that does not exist', async () => {
    const path = join(dir, 'NOPE.md');
    expect(await previewWrite(path, BLOCK)).toBe('created');
  });

  it('predicts "appended" when file exists without markers', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '# User content\n', 'utf-8');
    expect(await previewWrite(path, BLOCK)).toBe('appended');
  });

  it('predicts "updated" when block content would change', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, BLOCK, 'utf-8');
    expect(await previewWrite(path, OTHER_BLOCK)).toBe('updated');
  });

  it('predicts "no-change" when block would be byte-identical', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, BLOCK, 'utf-8');
    expect(await previewWrite(path, BLOCK)).toBe('no-change');
  });

  it('propagates MalformedMarkersError on malformed targets', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '<!-- loom:start v1 -->\nno end\n', 'utf-8');
    await expect(previewWrite(path, BLOCK)).rejects.toBeInstanceOf(MalformedMarkersError);
  });
});
