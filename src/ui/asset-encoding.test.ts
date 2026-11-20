import { expect, it } from 'vitest';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { packAsset } from './asset-encoding.js';

it('cold asset compression yields to the event loop and shares concurrent work', async () => {
  const body = Buffer.from('export const words = "the app stays responsive while its assets are compressed";\n'.repeat(2_000));
  let responsive = false;
  setImmediate(() => { responsive = true; });
  const first = packAsset('cold.js', body);
  const concurrent = packAsset('cold.js', body);
  const [a, b] = await Promise.all([first, concurrent]);
  expect(responsive, 'an unrelated request can run before cold compression finishes').toBe(true);
  expect(a).toBe(b);
  expect(await packAsset('cold.js', body)).toBe(a);
  expect(brotliDecompressSync(a.br)).toEqual(body);
  expect(gunzipSync(a.gzip)).toEqual(body);
});
