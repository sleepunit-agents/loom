// The PNG reader (src/png.ts): every row filter PNG defines, RGB as well as RGBA, and a damaged file refused as a
// PngError that names what's wrong, never a RangeError or zlib's own.
import { describe, it, expect } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { decodePng, PngError } from './png.js';
import { encodePng } from './png.fixture.js';

/** Pixels that differ everywhere, so a wrong predictor shows. */
const noise = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 73 + (i >> 3) * 151 + 17) & 0xff);

describe('decodePng', () => {
  it('reads RGBA through every row filter (none, sub, up, average, paeth)', () => {
    const px = noise(9 * 7 * 4);
    const { width, height, rgba } = decodePng(encodePng(9, 7, px, 4, [0, 1, 2, 3, 4]));
    expect([width, height]).toEqual([9, 7]);
    expect([...rgba]).toEqual([...px]);
  });

  it('reads RGB as RGBA, opaque', () => {
    const px = noise(5 * 4 * 3);
    const { rgba } = decodePng(encodePng(5, 4, px, 3, [4, 3, 2, 1]));
    for (let i = 0, j = 0; i < px.length; i += 3, j += 4) expect([...rgba.subarray(j, j + 4)]).toEqual([px[i], px[i + 1], px[i + 2], 255]);
  });

  it('refuses a damaged file as a PngError, saying what\'s wrong', () => {
    const good = encodePng(4, 4, noise(64), 4);
    const cases: Array<[string, Buffer, RegExp]> = [
      ['not a PNG', Buffer.from('GIF89a and then some more bytes to be long enough'), /isn't a PNG/],
      ['cut short in a chunk', good.subarray(0, 40), /cut short|damaged/],
      ['a row filter PNG doesn\'t define', (() => { const raw = Buffer.alloc(17 * 4); raw[0] = 9; return encodeRaw(4, 4, raw); })(), /row filter/],
      ['data that won\'t inflate', (() => { const b = Buffer.from(good); const at = b.indexOf('IDAT') + 4; b.fill(0xff, at, at + 6); return b; })(), /damaged|cut short/],
      ['fewer rows than it says', (() => { const b = Buffer.from(good); b.writeUInt32BE(64, 20); return b; })(), /cut short/],
    ];
    for (const [why, png, msg] of cases) {
      let err: unknown;
      try { decodePng(png); } catch (e) { err = e; }
      expect(err, why).toBeInstanceOf(PngError);
      expect((err as Error).message, why).toMatch(msg);
    }
  });
});

/** A PNG whose IDAT is these filtered bytes as given. */
function encodeRaw(w: number, h: number, raw: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
