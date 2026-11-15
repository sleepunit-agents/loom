/** Production HTTP/socket owner for the fresh shared composition. The caller
 * supplies the initialized connection and closes it only after this listener. */
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { sharedRoot } from './shared-root.js';

export async function serveShared(options: Parameters<typeof sharedRoot>[0] & { host?: string; port?: number }) {
  const root = sharedRoot(options);
  const sockets = new Set<Socket>();
  const server = createServer(getRequestListener(request => root.http.fetch(request)));
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let detach: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    void (async () => {
      const stopped = root.close();
      detach?.();
      const listening = new Promise<void>(done => server.close(() => done()));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      try { await stopped; } finally { await listening; }
    })().then(resolve, reject);
    return closing;
  };
  try {
    detach = root.attach(server);
    const host = options.host ?? '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', ready);
      server.listen(options.port ?? 0, host);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No shared listener address');
    return { ...root, url: `http://${host.includes(':') ? '[' + host + ']' : host}:${address.port}`, close };
  } catch (error) { await close(); throw error; }
}
