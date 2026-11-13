/** Composition and in-process test harness for the new application foundation. */
import { createServer } from 'node:http';
import { createFoundation, httpDoor, type Foundation } from './core/app.js';
import type { Clock } from './core/clock.js';
import type { Authentication } from './core/live/index.js';
import type { IncomingMessage } from 'node:http';
import { installSharing } from './pieces/sharing/index.js';
import { SharingDatabase } from './core/household/sharing.js';
import { installTasks } from './pieces/tasks/index.js';
import type { Sharing } from './core/index.js';
import { installNext, listenNext, type NextOptions } from './next.js';
import type { OutsideEffects } from './core/effects.js';
export { createFoundation } from './core/app.js';
export async function startLoom({ home, clock, install, authenticate, sharing, listen, next, staging, host, port, webRoot }: {
  home: string; clock?: Clock; sharing?: () => Sharing;
  next?: boolean; staging?: boolean; host?: string; port?: number; webRoot?: string;
  install?: (app: ReturnType<typeof createFoundation>) => void;
  authenticate?: (req: IncomingMessage) => Authentication | undefined;
  /** Transitional production transport; it owns piece installation and listener shutdown. */
  listen?: (app: Foundation) => Promise<{ url: string; close(): Promise<void> }>;
}): Promise<Omit<Foundation, 'close'> & { url: string; effects?: OutsideEffects; close(): Promise<void> }> {
  const app = createFoundation({ home, clock });
  let effects: OutsideEffects | undefined;
  const nextOptions: NextOptions = { home, staging, host, port, webRoot, authenticate, sharing };
  if (next && listen) { app.close(); throw new Error("next mode owns its listener"); }
  try { install?.(app); if (next) effects = installNext(app, nextOptions); if (!listen && !app.operations.has('tasks.list')) installTasks(app.db, app.operations, app.live, sharing ?? (() => ({ members: {}, projects: {}, services: {} }))); } catch (e) { app.close(); throw e; }
  if (next) {
    try {
      const server = await listenNext(app, nextOptions);
      return { ...app, effects, url: server.url, async close() { try { await server.close(); } finally { app.close(); } } };
    } catch (e) { app.close(); throw e; }
  }
  if (listen) {
    try {
      const server = await listen(app);
      return { ...app, url: server.url, async close() { try { await server.close(); } finally { app.close(); } } };
    } catch (error) { app.close(); throw error; }
  }
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
