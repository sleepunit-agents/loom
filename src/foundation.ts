/** Composition and in-process test harness for the new application foundation. */
import { createServer } from 'node:http';
import { createFoundation, httpDoor, type Foundation } from './core/app.js';
import type { Clock } from './core/clock.js';
import type { Authentication } from './core/live/index.js';
import type { IncomingMessage } from 'node:http';
export { createFoundation } from './core/app.js';
export async function startLoom({ home, clock, install, authenticate }: {
  home: string; clock?: Clock;
  install?: (app: ReturnType<typeof createFoundation>) => void;
  authenticate?: (req: IncomingMessage) => Authentication | undefined;
}): Promise<Foundation & { url: string; close(): Promise<void> }> {
  const app = createFoundation({ home, clock });
  try { install?.(app); } catch (e) { app.close(); throw e; }
  const auth = authenticate ?? (() => undefined);
  const http = createServer(httpDoor(app, auth));
  const detach = app.live.attach(http, auth);
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('no bound address');
  return { ...app, url: `http://127.0.0.1:${address.port}`, async close() {
    detach(); app.close(); http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve()));
  } };
}
