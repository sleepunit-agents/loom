import { describe, expect, it } from 'vitest';
import { gitSnapshot, type SnapshotGit } from './git-snapshot.js';
import { inspectHouseBuild } from './house-manifest.js';
const commit = 'a'.repeat(40), blob = 'b'.repeat(40), tree = 'c'.repeat(40), container = 'd'.repeat(40);
const manifest = JSON.stringify({ build: { context: 'house', containerfile: 'house/Containerfile' } });
function fixture() {
  const calls: { args: readonly string[]; limit: number }[] = [];
  const git: SnapshotGit = async (args, limit) => {
    calls.push({ args, limit });
    expect(args.slice(0, 2)).toEqual(['--no-replace-objects', '--literal-pathspecs']);
    switch (args[2]) {
      case 'rev-parse': return `${commit}\n`;
      case 'ls-tree': {
        const file = args.at(-1)!;
        if (file === 'house') return `040000 tree ${tree}\thouse\0`;
        return `100644 blob ${file.endsWith('.json') ? blob : container}\t${file}\0`;
      }
      case 'cat-file': return args[3] === '-s' ? `${Buffer.byteLength(manifest)}\n` : manifest;
      default: throw new Error('Unexpected Git command');
    }
  };
  return { calls, git };
}
describe('Git build snapshot reader', () => {
  it('reads the full house at a once-resolved commit through bounded literal argv', async () => {
    const { git, calls } = fixture();
    const snapshot = await gitSnapshot(git, 'refs/heads/main');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(await inspectHouseBuild(snapshot, 'art')).toMatchObject({ commit, image: 'loom-house-art:ccccccccccccdddddddd', house: { task: 'stdin' } });
    expect(calls[0]).toEqual({ args: ['--no-replace-objects', '--literal-pathspecs', 'rev-parse', '--verify', '--end-of-options', 'refs/heads/main^{commit}'], limit: 128 });
    expect(calls.filter(c => c.args[2] === 'rev-parse')).toHaveLength(1);
    expect(calls.filter(c => c.args[2] === 'ls-tree').map(c => c.args.slice(3))).toEqual([
      ['-z', '--full-tree', commit, '--', 'house/house.json'],
      ['-z', '--full-tree', commit, '--', 'house'],
      ['-z', '--full-tree', commit, '--', 'house/Containerfile'],
    ]);
    expect(calls.filter(c => c.args[2] === 'cat-file')).toEqual([
      { args: ['--no-replace-objects', '--literal-pathspecs', 'cat-file', '-s', blob], limit: 32 },
      { args: ['--no-replace-objects', '--literal-pathspecs', 'cat-file', 'blob', blob], limit: 4 * 1024 * 1024 },
    ]);
  });
  it('rejects revision expressions before IO and cross-commit or invalid paths before reading', async () => {
    for (const revision of ['--help', 'main', 'HEAD~1', 'HEAD:house', 'refs/heads/a..b', 'refs/heads/a.lock', 'refs/heads/.hidden', 'refs/heads/a//b', 'refs/heads/a/', 'refs/heads/a.']) {
      const { git, calls } = fixture();
      await expect(gitSnapshot(git, revision)).rejects.toThrow(); expect(calls).toEqual([]);
    }
    const { git, calls } = fixture(); const snapshot = await gitSnapshot(git);
    for (const file of ['../house', '/house', '.', 'house//x', 'house/../x', ':(glob)*', 'a\0b']) {
      await expect(snapshot.object(commit, file)).rejects.toThrow();
    }
    await expect(snapshot.text('e'.repeat(40), 'house/house.json')).rejects.toThrow('commit mismatch');
    expect(calls).toHaveLength(1);
  });
  it('rejects missing, ambiguous, symlink and malformed tree entries', async () => {
    for (const raw of ['', `120000 blob ${blob}\tx\0`, `040000 blob ${blob}\tx\0`, `100644 blob z\tx\0`,
      `100644 blob ${blob}\ty\0`, `100644 blob ${blob}\tx\0extra`, `100644 blob ${blob}\tx\0`.repeat(2), 'x'.repeat(4097)]) {
      const snapshot = await gitSnapshot(async args => args[2] === 'rev-parse' ? commit : raw);
      await expect(snapshot.object(commit, 'x')).rejects.toThrow();
    }
    const { git } = fixture(); const snapshot = await gitSnapshot(git);
    await expect(snapshot.text(commit, 'house')).rejects.toThrow('regular file');
  });
  it('refuses oversized or malformed sizes before blob reading and checks actual bytes', async () => {
    for (const size of ['4194305\n', '-1\n', '1.5\n', 'NaN\n', '03\n', '3\nextra']) {
      const { git, calls } = fixture();
      const snapshot = await gitSnapshot((args, limit) => args[2] === 'cat-file' ? Promise.resolve(size) : git(args, limit));
      await expect(snapshot.text(commit, 'house/house.json')).rejects.toThrow();
      expect(calls.some(c => c.args[3] === 'blob')).toBe(false);
    }
    const { git } = fixture();
    for (const text of ['short', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
      const snapshot = await gitSnapshot((args, limit) => args[3] === 'blob' ? Promise.resolve(text) : git(args, limit));
      await expect(snapshot.text(commit, 'house/house.json')).rejects.toThrow();
    }
    const unicode = '{"x":"é"}';
    const snapshot = await gitSnapshot((args, limit) => args[2] === 'cat-file'
      ? Promise.resolve(args[3] === '-s' ? `${Buffer.byteLength(unicode)}\n` : unicode) : git(args, limit));
    expect(await snapshot.text(commit, 'x')).toBe(unicode);
  });
  it('accepts SHA-256 snapshots and gitlinks, propagates failures, and validates the complete manifest', async () => {
    const id = 'f'.repeat(64);
    const snapshot = await gitSnapshot(async args => args[2] === 'rev-parse' ? id : `160000 commit ${id}\tsubmodule\0`, id);
    expect(await snapshot.object(id, 'submodule')).toEqual({ id, type: 'commit' });
    await expect(gitSnapshot(async () => 'HEAD')).rejects.toThrow('object id');
    await expect(gitSnapshot(async () => { throw new Error('Git failed'); })).rejects.toThrow('Git failed');
    const { git, calls } = fixture(); const invalid = JSON.stringify({ privileged: true });
    const bad = await gitSnapshot((args, limit) => args[2] === 'cat-file'
      ? Promise.resolve(args[3] === '-s' ? `${Buffer.byteLength(invalid)}\n` : invalid) : git(args, limit));
    await expect(inspectHouseBuild(bad, 'art')).rejects.toThrow();
    expect(calls.filter(c => c.args[2] === 'ls-tree')).toHaveLength(1);
  });
});
