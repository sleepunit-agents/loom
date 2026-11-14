/** Holder-process handoff primitive. The daemon receives only an empty ack. */
import https from 'node:https';
import type { ClientRequest } from 'node:http';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import { chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { certificateFingerprint } from './holder-authority.js';
import { assertPrivateDirectory, privateSocket, tlsMaterial, type LocalHolderConfig } from './local-holder.js';
import { secretName } from './input.js';
import type { SecretValueSource } from './service.js';

const ticket = z.uuid();
const failed = () => new Error('Secret handoff unavailable');
/** Trusted holder-side destination, NEVER supplied by a registry caller. Resolve
 * an opaque ticket against fresh central authority: exact body, job, assigned
 * runner, grant, policy, staging release and ticket lifetime. current must fence
 * that SAME destination after awaits. handTo is the authenticated runner
 * transport and must recheck authority at its final release boundary. It may
 * neither return bytes to the daemon nor retain this borrowed buffer after
 * settlement. No pass-through authority or daemon value reader is valid here.
 *
 * Ticket admission/one-use fencing and the real runner transport are separate
 * prerequisites; this primitive is not installed by normal holder startup.
 */
export interface HolderDestination {
  name: string;
  current(): Promise<boolean>;
  handTo(bytes: Uint8Array): Promise<void>;
  /** Retire the original claim on EVERY failed path, including before handTo.
   * Success remains claimed until the owning completion protocol settles it. */
  abandon?(): Promise<void>;
}
export type HolderHandoffAuthority = (id: string) => Promise<HolderDestination | null>;

/** Metadata-only daemon client. An uncertain ack MUST NOT be retried without
 * the owning ticket protocol proving a retry safe. No automatic retry here. */
export function localHolderHandoff(config: LocalHolderConfig, holderFingerprint: string) {
  try { certificateFingerprint.parse(holderFingerprint); } catch { throw failed(); }
  const material = tlsMaterial(config);
  if (!isAbsolute(config.socket) || !config.servername) throw failed();
  let closed = false;
  const requests = new Set<ClientRequest>();
  return {
    async handTo(id: string): Promise<void> {
      try {
        if (closed) throw failed();
        ticket.parse(id); privateSocket(config.socket);
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const fail = () => { if (!settled) { settled = true; reject(failed()); } };
          const req = https.request({ ...material, socketPath: config.socket, servername: config.servername,
            rejectUnauthorized: true, agent: false, minVersion: 'TLSv1.3', maxHeaderSize: 8192,
            checkServerIdentity: (host, cert) => checkServerIdentity(host, cert) ?? (cert.fingerprint256 === holderFingerprint ? undefined : failed()),
            method: 'POST', path: `/v1/handoff/${id}`, headers: {'content-length': 0},
          }, res => {
            if (closed || !(res.socket as TLSSocket).authorized
              || (res.socket as TLSSocket).getPeerCertificate().fingerprint256 !== holderFingerprint
              || res.statusCode !== 204 || res.headers['content-length'] !== '0' || res.headers['transfer-encoding']) {
              fail(); res.destroy(); return;
            }
            res.on('data', (b: Buffer) => { b.fill(0); fail(); res.destroy(); });
            res.on('error', fail); res.on('aborted', fail);
            res.on('end', () => { if (!settled) { settled = true; resolve(); } });
          });
          requests.add(req);
          const timer = setTimeout(() => { fail(); req.destroy(); }, 5000);
          req.on('error', fail);
          req.once('close', () => { clearTimeout(timer); requests.delete(req); });
          req.end();
        });
      } catch { throw failed(); }
    },
    async close() {
      closed = true;
      await Promise.all([...requests].map(req => new Promise<void>(resolve => { req.once('close', resolve); req.destroy(); })));
    },
  };
}

/** Real mutual-TLS local command channel, intended to live in the holder
 * process. Only its source and runner transport see plaintext. Closing drains
 * active handlers before source/authority storage can be closed. A timeout or
 * disconnect fences release before handTo; already-started runner delivery is
 * uncertain and cannot be rolled back by destroying this local request.
 */
export async function listenHolderHandoff(config: Omit<LocalHolderConfig, 'servername'>,
  source: SecretValueSource, daemonFingerprint: string, authority: HolderHandoffAuthority) {
  try {
    certificateFingerprint.parse(daemonFingerprint);
    if (!isAbsolute(config.socket) || typeof authority !== 'function') throw failed();
    assertPrivateDirectory(dirname(config.socket));
    const material = tlsMaterial(config);
    let closed = false;
    const active = new Set<Promise<void>>();
    const connections = new WeakMap<object, {expired: boolean; deadline: number}>();
    const server = https.createServer({...material, requestCert: true, rejectUnauthorized: true,
      minVersion: 'TLSv1.3', maxHeaderSize: 8192}, (req, res) => {
      const work = (async () => {
        let bytes: Uint8Array | undefined, expired = false;
        let destination: HolderDestination | null = null, delivered = false;
        const deadline = setTimeout(() => { expired = true; req.destroy(); res.destroy(); }, 5000);
        const peer = req.socket as TLSSocket;
        // Node's TLS socket wraps the accepted net.Socket. Carry the original
        // acceptance fence across that wrapper; unsupported wrappers fail closed.
        const connection = connections.get(peer) ?? connections.get((peer as TLSSocket & {_parent?: object})._parent ?? {});
        const alive = () => !!connection && !connection.expired && Date.now() < connection.deadline
          && !closed && !expired && !res.destroyed;
        res.on('error', () => {});
        try {
          const match = /^\/v1\/handoff\/([^/]+)$/.exec(req.url ?? '');
          if (!alive() || !peer.authorized || peer.getPeerCertificate().fingerprint256 !== daemonFingerprint
            || req.method !== 'POST' || !match || req.headers['content-length'] !== '0' || req.headers['transfer-encoding']) throw failed();
          const id = ticket.parse(match[1]);
          destination = await authority(id);
          if (!alive() || !destination || !secretName.safeParse(destination.name).success
            || await destination.current() !== true || !alive()) throw failed();
          bytes = await source.read(destination.name);
          if (!alive() || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 65536
            || await destination.current() !== true || !alive()) throw failed();
          // The trusted destination owns final runner identity and release fencing.
          await destination.handTo(bytes);
          if (!alive()) throw failed();
          res.writeHead(204, {'content-length': 0, 'cache-control': 'no-store'}); res.end();
          delivered = true;
        } catch {
          if (!res.headersSent && !res.destroyed) res.writeHead(503, {'content-length': 0, 'cache-control': 'no-store'});
          res.end();
        } finally {
          clearTimeout(deadline);
          if (bytes instanceof Uint8Array) bytes.fill(0);
          if (!delivered) try { await destination?.abandon?.(); } catch { /* uncertain; never retry */ }
        }
      })();
      active.add(work); void work.catch(() => {}).finally(() => active.delete(work));
    });
    server.on('connection', socket => {
      const state = {expired: false, deadline: Date.now() + 5000};
      connections.set(socket, state);
      const timer = setTimeout(() => { state.expired = true; socket.destroy(); }, 5000);
      socket.once('close', () => { state.expired = true; clearTimeout(timer); });
    });
    server.requestTimeout = 5000; server.headersTimeout = 5000;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve); });
      chmodSync(config.socket, 0o600);
    } catch { server.close(); throw failed(); }
    let closing: Promise<void> | undefined;
    return {close() { return closing ??= (async () => {
      closed = true; server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(failed()) : resolve()));
      await Promise.all(active);
    })(); }};
  } catch { throw failed(); }
}
