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
  read(id: string, viewer: Viewer): LiveRecord | undefined;
  /** Candidate ids, with read doing the permission check for each. */
  ids(scope: string | undefined): string[];
  inScope(record: LiveRecord, scope: string | undefined, now: number): boolean;
  /** The next instant this record may leave a time-bounded scope. */
  expires?(record: LiveRecord, scope: string | undefined): number | undefined;
}
const subscribe = z.object({ kind: z.literal('subscribe'), type: z.string(), scope: z.string().optional() });
const call = z.object({ kind: z.literal('call'), request: z.string(), name: z.string(), input: z.unknown(), id: z.string().optional() });
interface Subscriber { viewer: Viewer; send(value: unknown): void; types: Map<string, { type: RecordType; scope?: string; sent: Set<string>; cancel: Map<string, () => void> }> }
export interface Authentication { viewer: Viewer; valid(): boolean; expiresAt?: number }
export class Live {
  private types = new Map<string, RecordType>();
  private emitter = new EventEmitter();
  private clients = new Set<Subscriber>();
  private sockets = new Map<WebSocket, Authentication>();
  private ws = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  constructor(private clock: Clock, private ops: Operations) {
    this.emitter.on('changed', (changes: Change[]) => {
      for (const c of this.clients) for (const sub of c.types.values()) for (const change of changes) {
        if (sub.type.name === change.type) { try { this.update(c, sub, change.id); } catch { c.send({ ok: false, code: 'unavailable', message: 'Subscription could not update' }); } }
      }
    });
  }
  register(type: RecordType) { if (this.types.has(type.name)) throw new Error('duplicate record type'); this.types.set(type.name, type); }
  changed(changes: Change[]) {
    if (changes.some(c => c.type === 'core.access')) this.refreshAccess();
    this.emitter.emit('changed', changes);
  }
  private update(c: Subscriber, sub: Subscriber['types'] extends Map<string, infer T> ? T : never, id: string) {
    sub.cancel.get(id)?.(); sub.cancel.delete(id);
    const r = sub.type.read(id, c.viewer);
    if (r && sub.type.inScope(r, sub.scope, this.clock.now())) {
      sub.sent.add(id); c.send({ kind: 'put', type: sub.type.name, scope: sub.scope, record: r });
      const until = sub.type.expires?.(r, sub.scope);
      if (until !== undefined && until > this.clock.now()) sub.cancel.set(id, this.clock.at(until, () => { try { this.update(c, sub, id); } catch { c.send({ ok: false, code: 'unavailable', message: 'Subscription could not update' }); } }));
    } else if (sub.sent.delete(id)) c.send({ kind: 'del', type: sub.type.name, scope: sub.scope, id });
  }
  private set(c: Subscriber, type: RecordType, scope?: string) {
    const key = JSON.stringify([type.name, scope]);
    const old = c.types.get(key); old?.cancel.forEach(cancel => cancel());
    const sub = { type, scope, sent: new Set<string>(), cancel: new Map<string, () => void>() };
    c.types.set(key, sub);
    const records = type.ids(scope).map(id => type.read(id, c.viewer)).filter((r): r is LiveRecord => !!r && type.inScope(r, scope, this.clock.now()));
    for (const r of records) {
      sub.sent.add(r.id);
      const until = type.expires?.(r, scope);
      if (until !== undefined && until > this.clock.now()) sub.cancel.set(r.id, this.clock.at(until, () => { try { this.update(c, sub, r.id); } catch { c.send({ ok: false, code: 'unavailable', message: 'Subscription could not update' }); } }));
    }
    c.send({ kind: 'set', type: type.name, scope, records });
  }
  /** Called by the session/member/ownership operations, never a polling loop. */
  refreshAccess() {
    for (const [socket, auth] of this.sockets) if (!auth.valid()) socket.close(1008, 'Session ended');
    for (const c of this.clients) for (const sub of [...c.types.values()]) { try { this.set(c, sub.type, sub.scope); } catch { c.send({ ok: false, code: 'unavailable', message: 'Subscription could not load' }); } }
  }
  attach(server: Server, authenticate: (req: IncomingMessage) => Authentication | undefined) {
    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/live') return;
      let auth: Authentication | undefined;
      try { auth = authenticate(req); } catch { /* fail closed */ }
      // A cookie-authenticated browser must be same-origin. Nonbrowser tokens have no Origin.
      if (!auth || !auth.valid() || (req.headers.origin && req.headers.origin !== `${('encrypted' in req.socket && req.socket.encrypted) ? 'https' : 'http'}://${req.headers.host}`)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
      }
      const authenticated = auth;
      this.ws.handleUpgrade(req, socket, head, ws => {
        const auth = authenticated;
        const stopExpiry = auth.expiresAt === undefined ? undefined : this.clock.at(auth.expiresAt, () => ws.close(1008, 'Session ended'));
        this.sockets.set(ws, auth);
        const c: Subscriber = { viewer: auth.viewer, types: new Map(), send: value => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); } };
        this.clients.add(c);
        ws.on('message', raw => {
          if (!auth.valid()) { ws.close(1008, 'Session ended'); return; }
          let data: unknown; try { data = JSON.parse(raw.toString()); } catch { c.send({ ok: false, code: 'invalid', message: 'Invalid JSON' }); return; }
          const s = subscribe.safeParse(data);
          if (s.success) {
            const type = this.types.get(s.data.type);
            if (type) { try { this.set(c, type, s.data.scope); } catch { c.send({ ok: false, code: 'unavailable', message: 'Subscription could not load' }); } }
            else c.send({ ok: false, code: 'not-found', message: 'Unknown record type' });
            return;
          }
          const op = call.safeParse(data);
          if (!op.success) { c.send({ ok: false, code: 'invalid', message: 'Invalid socket message' }); return; }
          c.send({ kind: 'pending', request: op.data.request });
          const result = this.ops.call('socket', c.viewer, op.data.name, op.data.input, op.data.id);
          c.send({ kind: 'result', request: op.data.request, result });
        });
        ws.on('close', () => { stopExpiry?.(); this.sockets.delete(ws); this.clients.delete(c); for (const s of c.types.values()) s.cancel.forEach(cancel => cancel()); });
        ws.on('error', () => ws.close());
      });
    };
    server.on('upgrade', upgrade);
    return () => server.off('upgrade', upgrade);
  }
  close() { for (const socket of this.sockets.keys()) socket.terminate(); for (const c of this.clients) for (const s of c.types.values()) s.cancel.forEach(cancel => cancel()); this.clients.clear(); this.ws.close(); }
}
