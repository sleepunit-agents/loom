import {listenForTouchSources} from './core/touched/group.js';
import {prepareSharedMemorySources,validateSharedMemoryOptions} from './shared-memory.js';
import {sharedWeb} from './shared-web.js';
import { measureResponse } from './core/measuring/response.js';
/** Production HTTP/socket owner for the fresh shared composition. The caller
 * supplies the initialized connection and closes it only after this listener. */
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { sharedRoot } from './shared-root.js';

export async function serveShared(options: Parameters<typeof sharedRoot>[0] & { host?: string; port?: number; webRoot?:string }) {
  const web=options.webRoot?sharedWeb(options.webRoot):undefined;
  validateSharedMemoryOptions(options.db,options.memory);await prepareSharedMemorySources(options.memory);
  const root = sharedRoot(options);
  const sockets = new Set<Socket>();
  let meter: Awaited<typeof root.measuring> | undefined;
  const listener = getRequestListener(async request=>{const response=await root.http.fetch(request);return web&&response.status===404&&['GET','HEAD'].includes(request.method)?web.fetch(request):response;});
  const server = createServer((request, response) => {
    const pending = measureResponse(meter, request, response, () => { void listener(request, response); });
    void pending?.catch(() => { if (!response.headersSent) response.writeHead(503); response.end(); });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    // HTTP gives up its raw error handler on upgrade; a denied handshake can
    // still receive a peer reset before close completes. Keep the owner here.
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  let detach: (() => void) | undefined;
  let stopTouches:(()=>Promise<void>)|undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    void (async () => {
      const touchesStopped=stopTouches?.();
      const stopped = root.close();
      detach?.();
      const listening = new Promise<void>(done => server.close(() => done()));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      try { await Promise.all([stopped,touchesStopped]); } finally { await listening; }
    })().then(resolve, reject);
    return closing;
  };
  try {
    await root.ready;
    meter = await root.measuring;
    stopTouches=await listenForTouchSources(root.operations,root.memory.touches);
    detach = root.attach(server);
    // Only GraphQL upgrades are installed on this listener.
    server.on('upgrade',(request,socket)=>{if(new URL(request.url??'/', 'http://localhost').pathname!=='/graphql')socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
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
