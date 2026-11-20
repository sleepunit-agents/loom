// PNGs for tests (png.test.ts, icon-set.test.ts), made here: any size, RGB or RGBA, any row filters.
import { crc32, deflateSync } from 'node:zlib';

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** A PNG of these pixels (channels 3 or 4), each row with the filter filters[y % filters.length]. */
export function encodePng(w: number, h: number, px: Uint8Array, channels: 3 | 4, filters = [0]): Buffer {
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const f = filters[y % filters.length];
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x];
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? px[(y - 1) * stride + x - channels] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 0xff;
    }
  }
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

