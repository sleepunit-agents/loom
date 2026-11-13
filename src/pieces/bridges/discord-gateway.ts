/** Discord JSON Gateway transport. Unregistered: composition owns authenticated
 * identity, setup/credential invalidation and the private durable receipt store. */
import WebSocket from 'ws';
import type { Clock } from '../../core/index.js';
import type { SecretUse } from '../secrets/role.js';

type Socket = Pick<WebSocket, 'on' | 'send' | 'terminate' | 'readyState'>;
type Json = Record<string, unknown>;
const object = (x: unknown): x is Json => !!x && typeof x === 'object' && !Array.isArray(x);
export interface DiscordCheckpoint { session: string; url: string; seq: number }
export interface DiscordDispatch { type: string; data: unknown; seq: number }
export interface DiscordGatewayOptions {
  bot: string;
  tokenSecret: string;
  secrets: SecretUse;
  clock: Clock;
  /** Outside-effect/lifetime check, including after deferred holder acquisition. */
  beforeConnect(): boolean;
  /** Private identity/credential-generation-bound storage. Never expose session
   * IDs as records. A replacement credential must never reuse this store. */
  load(): DiscordCheckpoint | undefined;
  /** Atomically retain needed raw events AND checkpoint before resolving.
   * Must not wait for metadata/admission/runtime. Deduplicate platform messages. */
  commit(event: DiscordDispatch, checkpoint: DiscordCheckpoint): Promise<void>;
  /** Durably forget the invalid resume cursor before another Identify. */
  reset(): Promise<void>;
  socket?: (url: string, options: WebSocket.ClientOptions) => Socket;
  random?: () => number;
}
const INITIAL = 'wss://gateway.discord.gg/?v=10&encoding=json';
function gateway(value: string): string {
  const url = new URL(value);
  url.search = '?v=10&encoding=json';
  if (url.protocol !== 'wss:' || !/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname)
    || url.username || url.password || url.port || url.hash || url.pathname !== '/') throw Error();
  return url.href;
}
const sequence = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const checkpointValid = (c: DiscordCheckpoint) => typeof c.session === 'string' && /^[\w-]{1,256}$/.test(c.session) && sequence(c.seq);
const fatal = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Resume uses the last COMMITTED sequence, heartbeats the last received sequence.
 * A disconnect waits for an in-flight commit before loading the next cursor.
 * Invalid sessions can lose events Discord no longer retains: no history replay. */
export function discordGateway(o: DiscordGatewayOptions): { close(): Promise<void> } {
  const { clock } = o;
  const dial = o.socket ?? ((url, options) => new WebSocket(gateway(url), options));
  let closed = false, stopped = false, generation = 0, failures = 0, pending = 0;
  let socket: Socket | undefined, checkpoint: DiscordCheckpoint | undefined;
  let queue: Promise<void> = Promise.resolve();
  const active = new Set<Promise<unknown>>();
  const timers = new Set<() => void>();
  let lastIdentify = -Infinity;
  function track<T>(p: Promise<T>): Promise<T> {
    active.add(p); void p.finally(() => active.delete(p)).catch(() => {}); return p;
  }
  function at(delay: number, fn: () => void) {
    let cancel!: () => void;
    const raw = clock.at(clock.now()+delay, () => { timers.delete(cancel); fn(); });
    cancel = () => { raw(); timers.delete(cancel); }; timers.add(cancel); return cancel;
  }
  function cancelTimers() { for (const cancel of timers) cancel(); }
  const alive = (epoch: number) => !closed && !stopped && epoch === generation;
  function retire() {
    generation++; cancelTimers(); const old = socket; socket = undefined; old?.terminate();
  }
  function reconnect(epoch: number, reset = false, terminal = false, minimum = 0) {
    if (!alive(epoch)) return;
    if (terminal) stopped = true;
    retire();
    const next = generation;
    const delay = Math.max(minimum, Math.min(60_000, 1000 * 2 ** Math.min(failures++,6)));
    // Never resume beyond an outstanding durable write, or clear its session
    // while that write can still put the old checkpoint back.
    const retiring = queue;
    void track((async () => {
      await retiring;
      if (closed || next !== generation || stopped) return;
      if (reset) { await o.reset(); checkpoint = undefined; }
      if (closed || next !== generation) return;
      at(delay, () => { if (alive(next)) start(); });
    })().catch(() => { stopped = true; cancelTimers(); }));
  }
  function send(s: Socket, epoch: number, value: unknown): Promise<void> {
    return new Promise((resolve,reject) => {
      if (!alive(epoch) || s.readyState !== WebSocket.OPEN || !o.beforeConnect()) { reject(Error()); return; }
      try { s.send(JSON.stringify(value), error => error ? reject(Error()) : resolve()); } catch { reject(Error()); }
    });
  }
  async function connect() {
    if (closed || stopped) return;
    const epoch = ++generation;
    try {
      if (!o.beforeConnect()) throw Error();
      checkpoint = o.load();
      if (checkpoint && !checkpointValid(checkpoint)) throw Error();
      const target = checkpoint ? gateway(checkpoint.url) : INITIAL;
      const s = dial(target, {maxPayload:1024*1024,followRedirects:false,perMessageDeflate:false,handshakeTimeout:15_000}); socket = s;
      let hello = false, authenticated = false, sessionReady = false, resumed = false, waitingAck = false;
      let received: number | null = checkpoint?.seq ?? null;
      let interval = 0, receivedDispatch = false;
      let deadline = at(15_000, () => reconnect(epoch));
      function writeHeartbeat() {
        waitingAck = true;
        void track(send(s,epoch,{op:1,d:received}).catch(() => reconnect(epoch)));
      }
      function beat() {
        if (!alive(epoch)) return;
        if (waitingAck) { reconnect(epoch); return; }
        writeHeartbeat();
        at(interval,beat);
      }
      s.on('error', () => reconnect(epoch));
      s.on('close', code => reconnect(epoch, code === 4007 || code === 4009, fatal.has(code)));
      s.on('message', (raw,binary) => {
        if (!alive(epoch)) return;
        try {
          const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
          if (binary || bytes.length > 1024*1024) throw Error();
          const f: unknown = JSON.parse(bytes.toString('utf8'));
          if (!object(f) || !Number.isInteger(f.op)) throw Error();
          if (f.op === 10) {
            if (hello || !object(f.d) || !Number.isSafeInteger(f.d.heartbeat_interval)
              || (f.d.heartbeat_interval as number) < 1000 || (f.d.heartbeat_interval as number) > 300_000) throw Error();
            hello = true; interval = f.d.heartbeat_interval as number;
            deadline(); deadline = at(15_000, () => reconnect(epoch));
            const jitter = (o.random ?? Math.random)();
            if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) throw Error();
            at(Math.floor(interval*jitter),beat);
            // Credential remains inside this one authenticated socket write.
            void track((async () => {
              if (!checkpoint && clock.now()-lastIdentify < 5000) throw Error();
              await o.secrets.withValue(o.tokenSecret, async token => {
                if (!alive(epoch) || !o.beforeConnect()) throw Error();
                const body = checkpoint ? {op:6,d:{token,session_id:checkpoint.session,seq:checkpoint.seq}}
                  : {op:2,d:{token,intents:37377,properties:{os:'linux',browser:'loom',device:'loom'}}};
                if (!checkpoint) lastIdentify = clock.now();
                authenticated = true;
                await send(s,epoch,body);
              });
              if (alive(epoch) && !receivedDispatch) {
                deadline(); deadline = at(15_000, () => reconnect(epoch));
              }
            })().catch(() => reconnect(epoch)));
            return;
          }
          if (!hello) throw Error();
          if (f.op === 11) { waitingAck = false; return; }
          if (f.op === 1) {
            // Server-requested beats do not move the periodic schedule.
            writeHeartbeat(); return;
          }
          if (f.op === 7) { reconnect(epoch); return; }
          if (f.op === 9) {
            if (typeof f.d !== 'boolean') throw Error();
            reconnect(epoch,!f.d,false,5000); return;
          }
          if (f.op !== 0) throw Error();
          if (!authenticated || !sequence(f.s) || typeof f.t !== 'string' || !/^[A-Z_]{1,80}$/.test(f.t)) throw Error();
          if (received !== null && f.s <= received) throw Error();
          received = f.s; receivedDispatch = true;
          let next: DiscordCheckpoint;
          if (f.t === 'READY') {
            if (sessionReady || checkpoint || !object(f.d) || !object(f.d.user) || f.d.user.id !== o.bot
              || typeof f.d.session_id !== 'string' || !/^[\w-]{1,256}$/.test(f.d.session_id)
              || typeof f.d.resume_gateway_url !== 'string') throw Error();
            next = {session:f.d.session_id,url:gateway(f.d.resume_gateway_url),seq:f.s};
            sessionReady = true;
          } else {
            // READY can still be queued: keep the session seed in this connection.
            if (!sessionReady && !checkpoint) throw Error();
            if (f.t === 'RESUMED') { if (!checkpoint || resumed) throw Error(); resumed = true; sessionReady = true; }
            const seed = checkpoint ?? readySeed;
            if (!seed) throw Error();
            next = {...seed,seq:f.s};
          }
          if (f.t === 'READY') readySeed = next;
          if (pending >= 64) throw Error();
          pending++;
          const event: DiscordDispatch = {type:f.t,data:f.d,seq:f.s};
          queue = track(queue.then(async () => {
            if (!alive(epoch)) return;
            await o.commit(event,next);
            checkpoint = next;
            if (alive(epoch)) { deadline(); failures = 0; }
          }).catch(() => reconnect(epoch)).finally(() => { pending--; }));
        } catch { reconnect(epoch); }
      });
      let readySeed: DiscordCheckpoint | undefined;
    } catch { reconnect(epoch); }
  }
  function start() { void track(connect()); }
  start();
  let closing: Promise<void> | undefined;
  return {close() {
    if (closing) return closing;
    closed = true; retire();
    return closing = Promise.allSettled([...active]).then(() => {});
  }};
}
