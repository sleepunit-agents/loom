// A PixelLab sprite sheet for tests (pixel-face and pixel-avatars integration tests), made here, not a file.
import { deflateSync, crc32 } from 'node:zlib';

/** The row of idle facing south in sheet(): 'Idle' is its third animation, after the rotations row. */
export const REST_ROW = (facings: string[]) => 1 + 2 * facings.length + facings.indexOf('south');
/** A sheet as PixelLab exports one: 56×84 cells, 17 columns, a rotations row, then each state in the facings given; a cyan
 * square in each cell (x 10 to 45, y 20 to 63), and in the rest frame a 2×2 magenta mark at (20, 21). */
export function sheet(facings = ['south', 'south-east', 'south-west']): { png: Buffer; json: Buffer } {
  const names = ['Error', 'Shift eyes rapidly from side to side to simulate reading', 'Idle', 'Thinking', 'Done', 'Waiting', 'Crack Neck'];
  const [cw, ch, cols, rows] = [56, 84, 17, 1 + names.length * facings.length];
  const [w, h] = [cw * cols, ch * rows];
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [cx, cy] = [x % cw, y % ch];
    if (cx >= 10 && cx < 46 && cy >= 20 && cy < 64) raw.set([0x2e, 0xe6, 0xf0, 255], y * (w * 4 + 1) + 1 + x * 4);
    // The rest frame (idle, south, frame 0) alone has a magenta mark near its figure's top: a small avatar is cut from it.
    if (x < cw && Math.floor(y / ch) === REST_ROW(facings) && cx >= 20 && cx < 22 && cy >= 21 && cy < 23) raw.set([0xff, 0x3d, 0xa8, 255], y * (w * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const json = Buffer.from(JSON.stringify({ character: { size: { width: 48, height: 48 } }, spritesheet: { cell_size: { width: cw, height: ch }, columns: cols,
    rows: [{ row: 0, type: 'rotations', frame_count: 8 }, ...names.flatMap((animation, i) => facings.map((direction, j) => ({ row: 1 + i * facings.length + j, type: 'animation', frame_count: 17, animation, direction })))] } }));
  return { png, json };
}

