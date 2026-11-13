import { describe, expect, it } from 'vitest';
import { inspectBuild, type BuildSnapshot } from './build-inspection.js';
const commit = '1'.repeat(40);
const objects = {
  house: { id: 'a'.repeat(40), type: 'tree' as const },
  'house/Containerfile': { id: 'b'.repeat(40), type: 'blob' as const },
  instructions: { id: 'c'.repeat(40), type: 'blob' as const },
  src: { id: 'd'.repeat(40), type: 'tree' as const },
};
function snapshot(build: unknown = { context: 'house', containerfile: 'house/Containerfile' }) {
  const reads: string[][] = [];
  const reader: BuildSnapshot = {
    commit,
    async text(at, file) { reads.push(['text', at, file]); return JSON.stringify({ build, command: ['claude'], services: {} }); },
    async object(at, file) {
      reads.push(['object', at, file]);
      if (!Object.hasOwn(objects, file)) throw new Error('No such object');
      return objects[file as keyof typeof objects];
    },
  };
  return { reader, reads };
}
describe('runner build snapshot inspection', () => {
  it('keeps the legacy no-watch image tag and pins all reads to one immutable commit', async () => {
    const { reader, reads } = snapshot();
    const text = reader.text;
    reader.text = async (at, file) => { reader.commit = '2'.repeat(40); return text(at, file); };
    expect(await inspectBuild(reader, 'art')).toEqual({ commit, image: 'loom-house-art:aaaaaaaaaaaabbbbbbbb' });
    expect(reads).toEqual([
      ['text', commit, 'house/house.json'], ['object', commit, 'house'], ['object', commit, 'house/Containerfile'],
    ]);
  });
  it('canonicalizes watches, includes their path names and ignores unrelated commits', async () => {
    const a = snapshot({ context: 'house', containerfile: 'house/Containerfile', watch: ['src', 'instructions', 'src'] });
    const b = snapshot({ context: 'house', containerfile: 'house/Containerfile', watch: ['instructions', 'src'] });
    b.reader.commit = '3'.repeat(40);
    const first = await inspectBuild(a.reader, 'art');
    const second = await inspectBuild(b.reader, 'art');
    expect(first.image).toBe('loom-house-art:df8443210197943a5e7b');
    expect(second.image).toBe(first.image);
    expect(a.reads.filter(r => r[0] === 'object').map(r => r[2])).toEqual(['house', 'house/Containerfile', 'instructions', 'src']);
    // A renamed watch with the same object still changes identity.
    const renamed = snapshot({ context: 'house', containerfile: 'house/Containerfile', watch: ['renamed', 'src'] });
    const readRenamed = renamed.reader.object;
    renamed.reader.object = (at, file) => readRenamed(at, file === 'renamed' ? 'instructions' : file);
    expect((await inspectBuild(renamed.reader, 'art')).image).not.toBe(first.image);
    const changed = snapshot({ context: 'house', containerfile: 'house/Containerfile', watch: ['src'] });
    expect((await inspectBuild(changed.reader, 'art')).image).not.toBe(first.image);
    const original = b.reader.object;
    b.reader.object = async (at, file) => ({ ...await original(at, file), ...(file === 'src' ? { id: 'e'.repeat(40) } : {}) });
    expect((await inspectBuild(b.reader, 'art')).image).not.toBe(first.image);
    const empty = snapshot({ context: 'house', containerfile: 'house/Containerfile', watch: [] });
    expect((await inspectBuild(empty.reader, 'art')).image).toBe('loom-house-art:aaaaaaaaaaaabbbbbbbb');
  });
  it('refuses invalid locators and build declarations before resolving objects', async () => {
    for (const build of [null, {}, { context: '.', containerfile: 'house/Containerfile' },
      { context: 'house', containerfile: '../Containerfile' }, { context: '/house', containerfile: 'Containerfile' },
      { context: 'house', containerfile: 'Containerfile', watch: ['a//b'] },
      { context: 'house', containerfile: 'Containerfile', watch: Array(65).fill('src') },
      { context: 'house', containerfile: 'Containerfile', extra: true }]) {
      const { reader, reads } = snapshot(build);
      await expect(inspectBuild(reader, 'art')).rejects.toThrow();
      expect(reads.every(r => r[0] === 'text')).toBe(true);
    }
    for (const [agent, file, ref] of [['Art', 'house/house.json', commit], ['art', '../house.json', commit], ['art', 'house.json', 'HEAD']]) {
      const { reader, reads } = snapshot(); reader.commit = ref;
      await expect(inspectBuild(reader, agent, file)).rejects.toThrow(); expect(reads).toEqual([]);
    }
  });
  it('fails on missing or malformed objects, wrong kinds and unreadable or oversized JSON', async () => {
    for (const result of [{ id: 'x', type: 'tree' }, { id: 'a'.repeat(40), type: 'blob' }, { id: 'a'.repeat(40), type: 'other' }]) {
      const { reader } = snapshot();
      reader.object = async () => result as Awaited<ReturnType<BuildSnapshot['object']>>;
      await expect(inspectBuild(reader, 'art')).rejects.toThrow();
    }
    const wrongFile = snapshot();
    const original = wrongFile.reader.object;
    wrongFile.reader.object = async (at, file) => ({ ...await original(at, file), type: 'tree' });
    await expect(inspectBuild(wrongFile.reader, 'art')).rejects.toThrow('Containerfile a blob');
    const missing = snapshot({ context: 'absent', containerfile: 'house/Containerfile' });
    await expect(inspectBuild(missing.reader, 'art')).rejects.toThrow('No such object');
    for (const text of ['{broken', 'null', '[]', ' '.repeat(4 * 1024 * 1024 + 1)]) {
      const { reader, reads } = snapshot(); reader.text = async () => text;
      await expect(inspectBuild(reader, 'art')).rejects.toThrow(); expect(reads).toEqual([]);
    }
    const { reader } = snapshot(); reader.text = async () => { throw new Error('Unavailable snapshot'); };
    await expect(inspectBuild(reader, 'art')).rejects.toThrow('Unavailable snapshot');
  });
});
