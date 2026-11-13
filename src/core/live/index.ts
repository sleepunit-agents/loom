import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Viewer } from '../../policy.js';
import type { Clock } from '../clock.js';
import type { Change, Operations } from '../operations/index.js';
export interface LiveRecord { id: string; [key: string]: unknown }
export interface RecordType {
  name: string;
  windowOnly?: boolean;
  /** Resolve encrypted fields outside SQLite. read is repeated before sending. */
  resolve?(record: LiveRecord): Promise<LiveRecord>;
  read(id: string, viewer: Viewer): LiveRecord | undefined;
  /** Candidate ids, with read doing the permission check for each. */
  ids(scope: string | undefined): string[];
  inScope(record: LiveRecord, scope: string | undefined, now: number): boolean;
  /** The next instant this record may leave a time-bounded scope. */
  expires?(record: LiveRecord, scope: string | undefined): number | undefined;
  /** A derived field depends on this change. Reread current and previously sent
   * candidates, including scoped records and deleted sources, for each viewer.
   */
  refreshOn?(change: Change): boolean;
}
const subscribe = z.object({ kind: z.literal('subscribe'), type: z.string(), scope: z.string().optional() });
const call = z.object({ kind: z.literal('call'), request: z.string(), name: z.string(), input: z.unknown(), id: z.string().optional() });
interface Subscriber { window: boolean; valid(): boolean; viewer: Viewer; send(value: unknown): void; close(): void; types: Map<string, { type: RecordType; scope?: string; sent: Set<string>; cancel: Map<string, () => void> }> }
export interface Authentication { window?: boolean; viewer: Viewer; valid(): boolean; expiresAt?: number }
export class Live {
  private types = new Map<string, RecordType>();
  private revisions = new WeakMap<object, number>();
  private emitter = new EventEmitter();
  private clients = new Set<Subscriber>();
  private sockets = new Map<WebSocket, Authentication>();
  private ws = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  constructor(private clock: Clock, private ops: Operations) {
    this.emitter.on('changed', (changes: Change[]) => {
      for (const c of this.clients) for (const sub of c.types.values()) {
        try {
          const ids = changes.some(change => sub.type.refreshOn?.(change))
            ? new Set([...sub.sent, ...sub.type.ids(sub.scope)])
            : new Set(changes.filter(change => sub.type.name === change.type).map(change => change.id));
          for (const id of ids) this.update(c, sub, id);
        } catch { this.failed(c); }
      }
    });
  }
  register(type: RecordType) { if (this.types.has(type.name)) throw new Error('duplicate record type'); this.types.set(type.name, type); }
  /** Derived records can invalidate through their owning piece's role without reading its tables. */
  observe(fn: (changes: Change[]) => void): () => void {
    this.emitter.on('changed', fn); return () => { this.emitter.off('changed', fn); };
  }
  changed(changes: Change[]) {
    if (changes.some(c => c.type === 'core.access')) this.refreshAccess();
    this.emitter.emit('changed', changes);
  }
  private failed(c: Subscriber) {
    c.send({ ok: false, code: 'unavailable', message: 'Subscription could not load' });
    this.clients.delete(c);
    for (const sub of c.types.values()) sub.cancel.forEach(cancel => cancel());
    c.close();
  }
  private update(c: Subscriber, sub: Subscriber['types'] extends Map<string, infer T> ? T : never, id: string) {
    if (sub.type.resolve) { void this.resolveSet(c, sub.type, sub.scope); return; }
    const r = sub.type.read(id, c.viewer);
    const visible = r && sub.type.inScope(r, sub.scope, this.clock.now());
    const until = visible ? sub.type.expires?.(r, sub.scope) : undefined;
    sub.cancel.get(id)?.(); sub.cancel.delete(id);
    if (visible) {
      sub.sent.add(id); c.send({ kind: 'put', type: sub.type.name, scope: sub.scope, record: r });
      if (until !== undefined && until > this.clock.now()) sub.cancel.set(id, this.clock.at(until, () => { try { this.update(c, sub, id); } catch { this.failed(c); } }));
    } else if (sub.sent.delete(id)) c.send({ kind: 'del', type: sub.type.name, scope: sub.scope, id });
  }
  private async resolveSet(c: Subscriber, type: RecordType, scope?: string) {
    const key = JSON.stringify([type.name, scope]);
    let sub = c.types.get(key);
    if (!sub) { sub = { type, scope, sent: new Set(), cancel: new Map() }; c.types.set(key, sub); }
    const version = (this.revisions.get(sub) ?? 0) + 1; this.revisions.set(sub, version);
    try {
      const candidates = type.ids(scope).map(id => type.read(id, c.viewer)).filter((r): r is LiveRecord => !!r && type.inScope(r, scope, this.clock.now()));
      const records = await Promise.all(candidates.map(r => type.resolve!(r)));
      if (!this.clients.has(c) || !c.valid() || this.revisions.get(sub) !== version) return;
      // A policy change or row revision during crypto cannot send an old plaintext snapshot.
      if (candidates.some(r => JSON.stringify(type.read(r.id, c.viewer)) !== JSON.stringify(r))) { this.set(c, type, scope); return; }
      c.send({ kind: 'set', type: type.name, scope, records });
      sub.sent = new Set(records.map(r => r.id));
    } catch { if (this.clients.has(c)) this.failed(c); }
  }
  private set(c: Subscriber, type: RecordType, scope?: string) {
    if (type.windowOnly && (!c.window || c.viewer.kind !== 'member')) { c.send({ ok: false, code: 'denied', message: 'A signed-in window is required' }); return; }
    if (type.resolve) { void this.resolveSet(c, type, scope); return; }
    const key = JSON.stringify([type.name, scope]);
    const old = c.types.get(key);
    const sub = { type, scope, sent: new Set<string>(), cancel: new Map<string, () => void>() };
    const records = type.ids(scope).map(id => type.read(id, c.viewer)).filter((r): r is LiveRecord => !!r && type.inScope(r, scope, this.clock.now()));
    const deadlines = records.map(r => ({ record: r, until: type.expires?.(r, scope) }));
    for (const { record: r, until } of deadlines) {
      sub.sent.add(r.id);
      if (until !== undefined && until > this.clock.now()) sub.cancel.set(r.id, this.clock.at(until, () => { try { this.update(c, sub, r.id); } catch { this.failed(c); } }));
    }
    old?.cancel.forEach(cancel => cancel());
    c.types.set(key, sub);
    c.send({ kind: 'set', type: type.name, scope, records });
  }
  /** Called by the session/member/ownership operations, never a polling loop. */
  refreshAccess() {
    for (const [socket, auth] of this.sockets) if (!auth.valid()) socket.close(1008, 'Session ended');
    for (const c of this.clients) for (const sub of [...c.types.values()]) { try { this.set(c, sub.type, sub.scope); } catch { this.failed(c); } }
  }
  attach(server: Server, authenticate: (req: IncomingMessage) => Authentication | undefined, originAllowed?: (req: IncomingMessage) => boolean) {
    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/live') return;
      let auth: Authentication | undefined;
      try { auth = authenticate(req); } catch { /* fail closed */ }
      // A cookie-authenticated browser must be same-origin. Nonbrowser tokens have no Origin.
      if (!auth || !auth.valid() || (originAllowed ? !originAllowed(req) : (req.headers.origin && req.headers.origin !== `${('encrypted' in req.socket && req.socket.encrypted) ? 'https' : 'http'}://${req.headers.host}`))) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
      }
      const authenticated = auth;
      this.ws.handleUpgrade(req, socket, head, ws => {
        const auth = authenticated;
        const stopExpiry = auth.expiresAt === undefined ? undefined : this.clock.at(auth.expiresAt, () => ws.close(1008, 'Session ended'));
        this.sockets.set(ws, auth);
        const c: Subscriber = { window: auth.window === true, valid: () => auth.valid(), viewer: auth.viewer, types: new Map(), close: () => ws.close(1011, 'Subscription failed'), send: value => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); } };
        this.clients.add(c);
        ws.on('message', async raw => {
          if (!auth.valid()) { ws.close(1008, 'Session ended'); return; }
          let data: unknown; try { data = JSON.parse(raw.toString()); } catch { c.send({ ok: false, code: 'invalid', message: 'Invalid JSON' }); return; }
          const s = subscribe.safeParse(data);
          if (s.success) {
            const type = this.types.get(s.data.type);
            if (type) { try { this.set(c, type, s.data.scope); } catch { this.failed(c); } }
            else c.send({ ok: false, code: 'not-found', message: 'Unknown record type' });
            return;
          }
          const op = call.safeParse(data);
          if (!op.success) { c.send({ ok: false, code: 'invalid', message: 'Invalid socket message' }); return; }
          c.send({ kind: 'pending', request: op.data.request });
          const result = await this.ops.callAsync('socket', c.viewer, op.data.name, op.data.input, op.data.id, auth.window === true);
          if (!auth.valid()) { ws.close(1008, 'Session ended'); return; }
          c.send({ kind: 'result', request: op.data.request, result });
        });
        ws.on('close', () => { stopExpiry?.(); this.sockets.delete(ws); this.clients.delete(c); for (const s of c.types.values()) s.cancel.forEach(cancel => cancel()); });
        ws.on('error', () => ws.close());
      });
    };
    server.on('upgrade', upgrade);
    return () => server.off('upgrade', upgrade);
  }
  close() { for (const socket of this.sockets.keys()) socket.terminate(); for (const c of this.clients) for (const s of c.types.values()) s.cancel.forEach(cancel => cancel()); this.clients.clear(); this.emitter.removeAllListeners(); this.ws.close(); }
}
