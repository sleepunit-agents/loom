import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
type Packed = { br: Buffer; gzip: Buffer };

// Prewarming and cold requests share the same work. Maximum-quality Brotli
// belongs on zlib's worker pool, never on the HTTP event loop.
const packed = new Map<string, Promise<Packed>>();
export function packAsset(file: string, body: Buffer): Promise<Packed> {
  const existing = packed.get(file);
  if (existing) return existing;
  const pending = Promise.all([
    brotliAsync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: body.length } }),
    gzipAsync(body, { level: 9 }),
  ]).then(([br, gzip]) => ({ br, gzip })).catch(error => {
    packed.delete(file);
    throw error;
  });
  packed.set(file, pending);
  return pending;
}
