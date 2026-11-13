/** Unregistered Socket Mode transport. The receiver must commit the raw payload
 * to its durable inbox before resolving; admission and normalization happen later.
 * A socket URL is a credential: it never leaves this module or enters diagnostics.
 */
import WebSocket from 'ws';
import type { Clock } from '../../core/index.js';
import type { SecretUse } from '../secrets/role.js';

type Socket = Pick<WebSocket, 'on' | 'send' | 'terminate' | 'ping' | 'readyState'>;
type Json = Record<string, unknown>;
const object = (x: unknown): x is Json => !!x && typeof x === 'object' && !Array.isArray(x);
export interface SlackSocketOptions {
  appSecret: string;
  secrets: SecretUse;
  clock: Clock;
  /** Composition's outside-effect gate, checked before acquisition AND dial. */
  beforeConnect(): boolean;
  /** Resolves only after durable receipt, even for a duplicate envelope.
   * Must durably retain or reject the payload before resolving. */
  receive(payload: Json): Promise<void>;
  request?: typeof fetch;
  socket?: (url: string) => Socket;
}
/** One connection at a time. Slack has no resume cursor: unacknowledged envelopes
 * are retried by Slack. Receiver deduplication must use platform event identity,
 * not envelope_id, which is only the ACK address. No history replay or polling.
 */
export function slackSocket(options: SlackSocketOptions): { close(): void } {
  const { clock } = options;
  let closed = false, generation = 0, failures = 0;
  let current: Socket | undefined;
  let cancelRetry: (() => void) | undefined, cancelHeartbeat: (() => void) | undefined;
  let cancelDeadline: (() => void) | undefined;
  let abort: AbortController | undefined;
  const dial = options.socket ?? (url => new WebSocket(url, { maxPayload: 1024 * 1024, followRedirects: false, handshakeTimeout: 15_000 }));
  function disconnect(epoch: number) {
    if (closed || epoch !== generation) return;
    generation++;
    cancelHeartbeat?.(); cancelDeadline?.(); abort?.abort();
    const old = current; current = undefined; old?.terminate();
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6));
    cancelRetry = clock.at(clock.now() + delay, () => { cancelRetry = undefined; void connect(); });
  }
  function heartbeat(socket: Socket, epoch: number) {
    cancelHeartbeat = clock.at(clock.now() + 30_000, () => {
      if (closed || epoch !== generation) return;
      cancelDeadline = clock.at(clock.now() + 10_000, () => disconnect(epoch));
      try { socket.ping(); } catch { disconnect(epoch); }
    });
  }
  async function connect() {
    if (closed) return;
    const epoch = ++generation;
    try {
      if (!options.beforeConnect()) throw Error();
      abort = new AbortController();
      const signal = abort.signal;
      cancelDeadline = clock.at(clock.now() + 15_000, () => disconnect(epoch));
      // Acquire through the current SERVICE grant on EVERY connection attempt.
      const url = await options.secrets.withValue(options.appSecret, async token => {
        const response = await (options.request ?? fetch)('https://slack.com/api/apps.connections.open', {
          method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!response.ok || !response.body) throw Error();
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength; if (size > 16_384) throw Error();
            chunks.push(part.value);
          }
        } finally { await reader.cancel(); }
        const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!object(data) || data.ok !== true || typeof data.url !== 'string') throw Error();
        const target = new URL(data.url);
        if (target.protocol !== 'wss:' || !/^wss(?:-[a-z0-9-]+)?\.slack\.com$/.test(target.hostname)
          || target.username || target.password || target.port || target.hash) throw Error();
        return target.href;
      });
      if (closed || epoch !== generation) return;
      if (!options.beforeConnect()) throw Error();
      const socket = dial(url); current = socket;
      let queue = Promise.resolve(), pending = 0, hello = false;
      socket.on('error', () => disconnect(epoch));
      socket.on('close', () => disconnect(epoch));
      socket.on('open', () => {
        if (closed || epoch !== generation) return;
        cancelDeadline?.();
        // A silent or non-Slack endpoint must not hold the transport forever.
        cancelDeadline = clock.at(clock.now() + 15_000, () => disconnect(epoch));
      });
      socket.on('pong', () => {
        if (closed || epoch !== generation) return;
        if (hello) { cancelDeadline?.(); cancelHeartbeat?.(); heartbeat(socket, epoch); }
      });
      socket.on('message', (raw, binary) => {
        if (closed || epoch !== generation) return;
        try {
          const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
          if (binary || bytes.length > 1024 * 1024) throw Error();
          const frame: unknown = JSON.parse(bytes.toString());
          if (!object(frame)) throw Error();
          if (frame.type === 'disconnect') { disconnect(epoch); return; }
          if (frame.type === 'hello') {
            if (hello) throw Error();
            hello = true; cancelDeadline?.(); failures = 0; heartbeat(socket, epoch); return;
          }
          if (!hello) throw Error();
          if (typeof frame.envelope_id !== 'string' || !frame.envelope_id || frame.envelope_id.length > 200) throw Error();
          if (++pending > 64) throw Error();
          queue = queue.then(async () => {
            if (closed || epoch !== generation) return;
            if (frame.type === 'events_api') {
              if (!object(frame.payload)) throw Error();
              await options.receive(frame.payload);
            } else if (frame.type !== 'interactive' && frame.type !== 'slash_commands') throw Error();
            // Unsupported interactive/slash payloads are deliberately consumed.
            // Never ACK a failed write or work finishing on an obsolete socket.
            if (!closed && epoch === generation && socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ envelope_id: frame.envelope_id }), error => { if (error) disconnect(epoch); });
          }).catch(() => disconnect(epoch)).finally(() => { pending--; });
        } catch { disconnect(epoch); }
      });
    } catch { disconnect(epoch); } // upstream errors can contain tokens or tickets
  }
  void connect();
  return { close() {
    if (closed) return;
    closed = true; generation++; cancelRetry?.(); cancelHeartbeat?.(); cancelDeadline?.(); abort?.abort();
    const old = current; current = undefined; old?.terminate();
  } };
}
