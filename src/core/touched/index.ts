/** Outside writers announce committed identities, never content. No watcher or retry queue. */
import { existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { clock as realClock, type Clock } from '../clock.js';
import { z } from 'zod';
import type { Viewer } from '../../policy.js';
import { operation, type Operations, type Change } from '../operations/index.js';
import { touchChange as change, touchReader } from './protocol.js';
export const touchSocketPath = (directory: string) => join(directory, '.loom-live', 'touched.sock');
export const hasTouchedListener = (directory: string) => existsSync(touchSocketPath(directory));
export interface TouchSource {
  /** Directory containing an existing agent/commons store. */
  directory: string;
  viewer: Viewer;
  /** Source-local identities become globally unique record ids here. Unknown types are rejected. */
  resolve(change: Change): Change | undefined;
}
/** The same notification operation as all other doors. It cannot write content or grant visibility. */
export function installTouched(operations: Operations, resolve: (viewer: Viewer, change: Change) => Change | undefined) {
  operations.register(operation({ name: 'core.touched', input: change, output: z.null(), doors: ['direct', 'mcp'],
    may: (viewer, input) => !!resolve(viewer, input),
    run(ctx, input) { const target = resolve(ctx.viewer, input); if (target) ctx.changed(target.type, target.id); return null; },
  }));
}
/** One private local socket per source. The daemon binds its caller, never trusts a caller in the message. */
export async function listenForTouches(operations: Operations, source: TouchSource): Promise<() => Promise<void>> {
  const clients = new Set<Socket>();
  const server = createServer(socket => {
    clients.add(socket); socket.setTimeout(1000, () => socket.destroy());
    const read = touchReader();
    let handled = false;
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clients.delete(socket));
    socket.on('data', chunk => {
      if (handled) return;
      try {
        const parsed = read(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (!parsed) return;
        handled = true;
        const target = source.resolve(parsed);
        const answer = target ? operations.call('direct', source.viewer, 'core.touched', target) : { ok: false };
        socket.end(JSON.stringify(answer) + '\n');
      } catch { socket.destroy(); }
    });
  });
  const privateDir = join(source.directory, '.loom-live');
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  chmodSync(privateDir, 0o700);
  const path = touchSocketPath(source.directory);
  const stop = async () => { for (const client of clients) client.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
  // Once binding succeeds, this function owns cleanup even if endpoint setup fails
  // before the group can receive our stop function.
  try {
    // Never steal an existing listener. Stale cleanup belongs to the home lock.
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    chmodSync(path, 0o600);
    return stop;
  } catch (error) {
    if (server.listening) await stop();
    throw error;
  }
}
/** Absent daemon: one existence check, no connection, timer, promise or waiting. Errors never undo a write. */
export function touched(directory: string, type: string, id: string, clock: Clock = realClock): void {
  try {
    const path = touchSocketPath(directory);
    if (!existsSync(path)) return;
    const socket = createConnection(path);
    const stopDeadline = clock.at(clock.now() + 250, () => socket.destroy());
    socket.once('close', stopDeadline);
    socket.on('error', () => socket.destroy());
    socket.on('connect', () => socket.write(JSON.stringify({ type, id }) + '\n'));
    socket.on('data', () => socket.destroy());
  } catch { /* discovery/connect failures cost a stale tile, never the committed write */ }
}
