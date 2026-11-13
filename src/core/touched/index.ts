/** Outside writers announce committed identities, never content. No watcher or retry queue. */
import { existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { z } from 'zod';
import type { Viewer } from '../../policy.js';
import { operation, type Operations, type Change } from '../operations/index.js';
const change = z.object({ type: z.string().min(1).max(80), id: z.string().min(1).max(2048) }).strict();
const socketPath = (directory: string) => join(directory, '.loom-touched.sock');
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
    let body = '', handled = false;
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clients.delete(socket));
    socket.on('data', chunk => {
      if (handled) return;
      body += chunk.toString();
      if (Buffer.byteLength(body) > 4096) { socket.destroy(); return; }
      if (!body.includes('\n')) return;
      handled = true;
      try {
        const parsed = change.safeParse(JSON.parse(body.slice(0, body.indexOf('\n'))));
        const target = parsed.success ? source.resolve(parsed.data) : undefined;
        const answer = target ? operations.call('direct', source.viewer, 'core.touched', target) : { ok: false };
        socket.end(JSON.stringify(answer) + '\n');
      } catch { socket.destroy(); }
    });
  });
  const path = socketPath(source.directory);
  // Never steal an existing listener. A stale endpoint is handled by daemon startup's home lock.
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  chmodSync(path, 0o600);
  return async () => { for (const client of clients) client.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
}
/** Absent daemon: one existence check, no connection, timer, promise or waiting. Errors never undo a write. */
export function touched(directory: string, type: string, id: string): void {
  try {
    const path = socketPath(directory);
    if (!existsSync(path)) return;
    const socket = createConnection(path);
    socket.setTimeout(250, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('connect', () => socket.write(JSON.stringify({ type, id }) + '\n'));
    socket.on('data', () => socket.destroy());
  } catch { /* discovery/connect failures cost a stale tile, never the committed write */ }
}
