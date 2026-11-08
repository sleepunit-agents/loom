// A PNG's pixels, read with node:zlib alone: 8-bit truecolour (with or without alpha), not interlaced. That's what a
// pixel icon is (PixelLab exports RGBA); anything else is refused, saying so, rather than read wrong.
import { inflateSync } from 'node:zlib';

const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngError extends Error {}

/** Its width, height and pixels, RGBA, row by row. Anything malformed (a chunk past the end, data that won't inflate) is a
 * PngError saying so, never a RangeError or zlib's own. */
export function decodePng(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  try { return decode(png); } catch (err) {
    if (err instanceof PngError) throw err;
    throw new PngError('is damaged (it can\'t be read as a PNG)');
  }
}

function decode(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  if (png.length < 33 || !png.subarray(0, 8).equals(MAGIC)) throw new PngError('isn\'t a PNG');
  let at = 8;
  let width = 0, height = 0, channels = 0;
  const idat: Buffer[] = [];
  let ended = false;
  while (at + 8 <= png.length) {
    const len = png.readUInt32BE(at);
    if (at + 12 + len > png.length) throw new PngError('is cut short');
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = data.subarray(8, 13);
      if (depth !== 8 || (colour !== 6 && colour !== 2) || interlace !== 0) throw new PngError('isn\'t an 8-bit RGB or RGBA PNG without interlacing');
      channels = colour === 6 ? 4 : 3;
      if (!width || !height || width > 4096 || height > 4096) throw new PngError('is larger than 4096 pixels a side');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { ended = true; break; }
    at += 12 + len;
  }
  if (!ended) throw new PngError('is cut short');
  if (!channels || !idat.length) throw new PngError('has no image data');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new PngError('is cut short');
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[row + x - channels] : 0;
      const b = y ? px[row - stride + x] : 0;
      const c = x >= channels && y ? px[row - stride + x - channels] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : -1;
      if (pred < 0) throw new PngError('has a row filter PNG doesn\'t define');
      px[row + x] = (src[x] + pred) & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: px };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) { rgba[j] = px[i]; rgba[j + 1] = px[i + 1]; rgba[j + 2] = px[i + 2]; rgba[j + 3] = 255; }
  return { width, height, rgba };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
