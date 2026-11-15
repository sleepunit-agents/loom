import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { useServer } from 'graphql-ws/use/ws';
import { execute, subscribe, GraphQLError, type ExecutionArgs, type GraphQLSchema } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { Authentication } from '../live/index.js';
import type { Clock } from '../clock.js';
import { ExecutionDrain, instrumentExecution } from './execution.js';
import { DataLive } from './live.js';
import { dataSubscriptions } from './subscriptions.js';

/** Standard graphql-transport-ws on /graphql. Authentication belongs to the
 * composition's existing session/token resolver, never connectionParams or an
 * operation argument. Share one instance across every bind address.
 */
export function dataSocket(options: {
  live: DataLive;
  clock: Clock;
  authenticate(request: IncomingMessage): Authentication | undefined;
  schema(viewer: Viewer): GraphQLSchema;
  originAllowed(request: IncomingMessage): boolean;
}) {
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, handleProtocols: protocols => protocols.has('graphql-transport-ws') ? 'graphql-transport-ws' : false });
  const admitted = new WeakMap<WebSocket, Authentication>();
  const cleanups = new Map<WebSocket, () => void>();
  let stopping = false, closing: Promise<void> | undefined;
  // Transport setup/direct reads and shared hub resolvers have independent lifetimes.
  const executions = new ExecutionDrain();
  function run<T>(operation: () => T) {
    if (stopping) throw new Error('Data access ended');
    return executions.scope(() => !stopping, operation);
  }
  const protocol = useServer({
    isProd: true,
    connectionInitWaitTimeout: 0, // the owned clock below bounds admission
    onConnect(ctx) { return !stopping && admitted.get(ctx.extra.socket)?.valid() === true; },
    schema(ctx) {
      if (stopping) throw new Error('Data access ended');
      const auth = admitted.get(ctx.extra.socket);
      if (!auth?.valid()) throw new Error('Authentication ended');
      auth.activity?.();
      const schema = dataSubscriptions(options.schema(auth.viewer), options.live, () => !stopping && auth.valid());
      instrumentExecution(schema);
      return schema;
    },
    context(ctx) {
      if (stopping) throw new Error('Data access ended');
      const auth = admitted.get(ctx.extra.socket);
      if (!auth?.valid()) throw new Error('Authentication ended');
      // The same server-resolved principal feeds direct reads and every live
      // execution. Neither variables nor connectionParams supply this context.
      return Object.freeze({ viewer: auth.viewer });
    },
    execute: (args: ExecutionArgs) => run(() => execute(args)),
    subscribe: (args: ExecutionArgs) => run(async () => {
      const result = await subscribe(args);
      if (stopping && Symbol.asyncIterator in result) {
        await result[Symbol.asyncIterator]().return?.();
        throw new Error('Data access ended');
      }
      return result;
    }),
    // Ordinary execution errors travel in next payloads, not onError. Drop
    // partial data as well: it may contain words from the failed projection.
    onNext(_ctx, _id, _payload, _args, result) {
      if (result.errors?.length) return { errors: [new GraphQLError('Data query could not complete')] };
    },
    // Never include database/driver errors or query-generated values in errors.
    onError() { return [{ message: 'Data subscription could not complete' }]; },
  }, ws, 0);
  function closeInvalid() {
    if (stopping) return;
    for (const socket of ws.clients) {
      const auth = admitted.get(socket);
      if (!auth?.valid()) socket.close(4403, 'Authentication ended');
    }
  }
  const detaches = new Set<() => void>();
  const attach = (server: Server) => {
    if (stopping) throw new Error('Data access ended');
    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/graphql') return;
      if (stopping) { socket.destroy(); return; }
      let auth: Authentication | undefined;
      try { auth = options.authenticate(request); } catch { /* fail closed */ }
      const protocols = request.headers['sec-websocket-protocol']?.split(',').map(s => s.trim());
      if (!auth?.valid() || auth.viewer.kind === 'service' || auth.viewer.kind === 'runner' ||
          (auth.window && !request.headers.origin) || !options.originAllowed(request) || !protocols?.includes('graphql-transport-ws')) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
      }
      const authentication = auth;
      ws.handleUpgrade(request, socket, head, socket => {
        admitted.set(socket, authentication);
        // The final send is the release boundary. graphql-ws can await hooks
        // between execution and ws.send; recheck even buffered initial results.
        const send = socket.send.bind(socket);
        socket.send = ((...args: Parameters<WebSocket['send']>) => {
          if (stopping || !authentication.valid()) {
            socket.close(4403, 'Authentication ended');
            const callback = args.at(-1);
            if (typeof callback === 'function') callback(new Error('Authentication ended'));
            return;
          }
          send(...args);
        }) as typeof socket.send;
        const cancelExpiry = authentication.expiresAt === undefined ? undefined : options.clock.at(authentication.expiresAt, () => socket.close(4403, 'Authentication ended'));
        let initialized = false;
        const cancelInit = options.clock.at(options.clock.now() + 10000, () => { if (!initialized) socket.close(4408, 'Connection initialisation timeout'); });
        socket.on('message', raw => {
          if (stopping) { socket.terminate(); return; }
          if (!authentication.valid()) socket.close(4403, 'Authentication ended');
          try { if (JSON.parse(raw.toString()).type === 'connection_init') { initialized = true; cancelInit(); } } catch { /* protocol validates */ }
        });
        cleanups.set(socket, () => { cancelExpiry?.(); cancelInit(); });
        socket.once('close', () => { cleanups.get(socket)?.(); cleanups.delete(socket); });
        authentication.activity?.();
        ws.emit('connection', socket, request);
      });
    };
    server.on('upgrade', upgrade);
    const detach = () => { server.off('upgrade', upgrade); detaches.delete(detach); };
    detaches.add(detach);
    return detach;
  };
  return { attach, refreshAccess: closeInvalid, close() {
    if (closing) return closing;
    stopping = true;
    // Publish the shared promise before cleanup callbacks can reenter close.
    closing = Promise.resolve().then(async () => {
      try {
        for (const detach of [...detaches]) detach();
        for (const cleanup of cleanups.values()) cleanup();
        cleanups.clear();
        for (const socket of ws.clients) socket.terminate();
        await protocol.dispose();
      } finally {
        await executions.drain();
        await options.live.drain();
      }
    });
    return closing;
  } };
}
