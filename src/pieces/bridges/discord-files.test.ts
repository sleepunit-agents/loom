import { expect, it, vi } from 'vitest';
import { DISCORD_FILES_PER_MESSAGE, discordFiles, fetchDiscordFiles } from './discord-files.js';
import { HANDED_FILE_BYTES } from './files.js';

const cdn = 'https://cdn.discordapp.com/attachments/1/2/';
const attachment = (id: string, more = {}) => ({ id, filename: `pic ${id}.png`, size: 100, content_type: 'image/png', url: `${cdn}${id}.png?ex=1`, ...more });

it('picks the attachments worth fetching: a Discord id, a link on Discord\'s file hosts, a size a body can be handed', () => {
  expect(discordFiles({ attachments: [attachment('11')] })).toEqual([{ id: '11', name: 'pic_11.png', url: `${cdn}11.png?ex=1` }]);
  expect(discordFiles({ attachments: [
    attachment('12', { url: 'https://evil.example/cdn.discordapp.com/x.png' }), attachment('13', { url: 'http://cdn.discordapp.com/x.png' }),
    attachment('14', { size: HANDED_FILE_BYTES + 1 }), attachment('../15'), attachment('16', { filename: '../../etc/passwd' }), { id: '17' }, 'nonsense',
  ] })).toEqual([{ id: '16', name: 'etc_passwd', url: `${cdn}16.png?ex=1` }]);
  expect(discordFiles({ attachments: Array.from({ length: 9 }, (_, n) => attachment(String(20 + n))) })).toHaveLength(DISCORD_FILES_PER_MESSAGE);
  for (const none of [{}, { attachments: [] }, { attachments: 'no' }, null, 'frame']) expect(discordFiles(none)).toEqual([]);
});

it('fetches each file on its own, with no credential and no redirect, and leaves out one it cannot have', async () => {
  const body = (bytes: number, type = 'image/png', status = 200) => new Response(Buffer.alloc(bytes, 7), { status, headers: { 'content-type': type } });
  const request = vi.fn<typeof fetch>(async url => {
    const name = String(url).slice(cdn.length);
    if (name.startsWith('gone')) return body(0, 'application/json', 404);
    if (name.startsWith('page')) return body(10, 'text/html; charset=utf-8');
    if (name.startsWith('huge')) return body(HANDED_FILE_BYTES + 1);
    if (name.startsWith('down')) throw Error('socket hang up');
    return body(5);
  });
  const files = ['ok', 'gone', 'page', 'huge', 'down'].map((name, index) => ({ id: String(index + 1), name: name + '.png', url: cdn + name + '.png' }));
  const fetched = await fetchDiscordFiles(files, () => true, request);
  expect(fetched.map(file => [file.id, file.name, file.bytes.byteLength])).toEqual([['1', 'ok.png', 5]]);
  expect(request).toHaveBeenCalledTimes(5);
  for (const [, options] of request.mock.calls) { expect(options).toMatchObject({ method: 'GET', redirect: 'error' }); expect(options?.headers).toBeUndefined(); }
  // A link that is not Discord's is never asked for, and nothing is fetched for a connection no longer in use.
  request.mockClear();
  expect(await fetchDiscordFiles([{ id: '9', name: 'x', url: 'https://example.test/x' }], () => true, request)).toEqual([]);
  expect(await fetchDiscordFiles(files, () => false, request)).toEqual([]);
  expect(request).not.toHaveBeenCalled();
});
