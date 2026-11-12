import { expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUi, legacyUiAuth } from './handler.js';
import { changed } from './live.js';

it('the single-agent handler closes a live stream when its bearer is revoked', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-live-credentials-'));
  const baseAuth = legacyUiAuth(['test']);
  let live = true, frames = '', ended = false;
  const auth = { ...baseAuth, live: (digest: Buffer) => live && baseAuth.live(digest) };
  const server = createServer((req, res) => { void handleUi(req, res, '/events', { contextDir: home, auth, env: { LOOM_HOME: home, PATH: '' } }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const stream = request(`http://127.0.0.1:${address.port}/events`, { headers: { authorization: 'Bearer test', accept: 'text/event-stream' } }, res => {
    res.setEncoding('utf8'); res.on('data', chunk => { frames += chunk; }); res.on('end', () => { ended = true; });
  });
  stream.on('error', () => {}); stream.end();
  try {
    await expect.poll(() => frames.includes('event: hello')).toBe(true);
    const before = frames;
    live = false; changed();
    await expect.poll(() => ended).toBe(true);
    expect(frames).toBe(before);
  } finally { stream.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});
