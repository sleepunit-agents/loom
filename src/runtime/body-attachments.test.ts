import { expect, it } from 'vitest';
import { BODY_ATTACHMENTS, saveBodyAttachments } from './body-attachments.js';

type Kept = { file: string; name: string; bytes: Buffer };
function fixture(kept: Record<string, Kept[]>) {
  const written = new Map<string, Buffer>(), asked: unknown[] = [];
  const client = { command: async (operation: string, input: unknown) => {
    asked.push([operation, input]);
    const { incoming, file } = input as { incoming: string; file?: string };
    const files = kept[incoming];
    if (!files) return { ok: false as const, code: 'denied' as const, message: 'no' };
    const rows = files.filter(row => !file || row.file === file).map(row => ({ file: row.file, name: row.name, bytes: row.bytes.byteLength, fetchedAt: '2026-11-17T00:00:00.000Z', ...(file ? { contents: row.bytes.toString('base64') } : {}) }));
    return { ok: true as const, value: { files: rows } };
  } };
  const write = (path: string, bytes: Buffer) => { written.set(path, Buffer.from(bytes)); };
  return { client: client as never, written, asked, write };
}

it('writes what was sent with the messages it took into the scratch directory, and names each file', async () => {
  const f = fixture({ 'bi:1': [{ file: 'A', name: 'cat photo.png', bytes: Buffer.from('PNG') }], 'bi:2': [{ file: 'B', name: '../../.ssh/key', bytes: Buffer.from('secret') }], 'bi:3': [] });
  const words = await saveBodyAttachments(f.client, ['bi:1', 'bi:2', 'bi:3'], '/scratch', f.write);
  const paths = [...f.written.keys()];
  expect(paths).toHaveLength(2);
  // Each is inside one new directory under the scratch directory, whatever its name was.
  expect(paths[0]).toMatch(/^\/scratch\/attachments-[0-9a-f-]{36}\/1-cat_photo\.png$/);
  expect(paths[1]).toMatch(/^\/scratch\/attachments-[0-9a-f-]{36}\/2-ssh_key$/);
  expect(f.written.get(paths[0])?.toString()).toBe('PNG');
  expect(words).toBe(`Files sent with these messages are saved here for you to open:\n- ${paths[0]} (cat_photo.png, 3 bytes)\n- ${paths[1]} (ssh_key, 6 bytes)`);
});

it('says nothing when there is nothing, no scratch directory, or loom will not say', async () => {
  const f = fixture({ 'bi:1': [] });
  expect(await saveBodyAttachments(f.client, ['bi:1'], '/scratch', f.write)).toBeNull();
  expect(await saveBodyAttachments(f.client, [], '/scratch', f.write)).toBeNull();
  expect(await saveBodyAttachments(f.client, ['bi:other'], '/scratch', f.write)).toBeNull();
  const with_ = fixture({ 'bi:1': [{ file: 'A', name: 'a', bytes: Buffer.from('x') }] });
  expect(await saveBodyAttachments(with_.client, ['bi:1'], undefined, with_.write)).toBeNull();
  expect(with_.asked).toEqual([]);
});

it('stops at the count it may write, keeps what it wrote when a later read fails, and never fails the caller', async () => {
  const many = fixture({ 'bi:1': Array.from({ length: 14 }, (_, n) => ({ file: 'F' + n, name: `n${n}.txt`, bytes: Buffer.from('x') })) });
  const words = await saveBodyAttachments(many.client, ['bi:1'], '/scratch', many.write);
  expect(many.written.size).toBe(BODY_ATTACHMENTS);
  expect(words?.split('\n')).toHaveLength(BODY_ATTACHMENTS + 1);
  const broken = fixture({ 'bi:1': [{ file: 'A', name: 'a', bytes: Buffer.from('x') }, { file: 'B', name: 'b', bytes: Buffer.from('y') }] });
  let n = 0;
  const words2 = await saveBodyAttachments(broken.client, ['bi:1'], '/scratch', (path, bytes) => { if (++n === 2) throw Error('disk full'); broken.write(path, bytes); });
  expect(words2?.split('\n')).toHaveLength(2);
});
