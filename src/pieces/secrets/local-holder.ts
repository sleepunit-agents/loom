/** Crypto-only local holder protocol. HTTPS is carried over a private Unix socket;
 * mutual TLS authenticates both peers before a name or value is sent. No TCP.
 */
import https from 'node:https';
import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { constants, openSync, fstatSync, readSync, closeSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { TLSSocket } from 'node:tls';
import type { SecretValueSource } from './service.js';
import { secretName } from './input.js';

const LIMIT = 64 * 1024;
const failed = () => new Error('Local secret holder unavailable');
/** Explicit private regular files only, opened without following a final symlink. */
export function privateBytes(path: string, limit = 64 * 1024): Buffer {
  let fd: number | undefined, bytes: Buffer | undefined;
  try {
    if (!isAbsolute(path) || !Number.isSafeInteger(limit) || limit < 1 || limit > 128 * 1024) throw failed();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.nlink !== 1 || s.size < 1 || s.size > limit) throw failed();
    bytes = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    const after = fstatSync(fd);
    if (used !== s.size || used > limit || after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs) throw failed();
    const result = Buffer.from(bytes.subarray(0, used));
    bytes.fill(0);
    return result;
  } catch { bytes?.fill(0); throw failed(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function assertPrivateDirectory(path: string) {
  if (!isAbsolute(path)) throw failed();
  const s = fs.lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw failed();
}
export function privateSocket(socket: string) {
  if (!isAbsolute(socket)) throw failed();
  assertPrivateDirectory(dirname(socket));
  const s = fs.lstatSync(socket);
  if (!s.isSocket() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw failed();
}
export interface LocalHolderConfig {
  socket: string;
  /** Dedicated holder CA, client/server certificates and private key, not household credentials. */
  ca: string; cert: string; key: string;
  /** Holder certificate DNS identity, verified by Node TLS. */
  servername: string;
}
export function tlsMaterial(config: Omit<LocalHolderConfig, 'servername'>) {
  try {
    const ca = privateBytes(config.ca), cert = privateBytes(config.cert), key = privateBytes(config.key);
    // Node's TLS context silently ignores malformed CA input. Require exactly
    // one dedicated PEM CA, parsed independently before starting either peer.
    const pem = ca.toString('ascii').trim();
    if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----$/.test(pem)
      || !new X509Certificate(pem).ca) throw failed();
    createSecureContext({ca, cert, key, minVersion:'TLSv1.3'});
    return {ca, cert, key};
  } catch { throw failed(); }
}
export interface HolderGeneration { generation(): Promise<string> | string }
const generationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function localSecretSource(config: LocalHolderConfig): SecretValueSource & HolderGeneration {
  const {ca, cert, key} = tlsMaterial(config);
  if (!config.servername || !isAbsolute(config.socket)) throw failed();
  async function acquire(path: string, limit: number) {
    try { privateSocket(config.socket); } catch { throw failed(); }
    return new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0, settled = false;
      const erase = () => { for (const b of chunks) b.fill(0); };
      const fail = () => { if (settled) return; settled = true; erase(); reject(failed()); };
      const request = https.request({socketPath: config.socket, servername: config.servername,
        path, method: 'GET', ca, cert, key, rejectUnauthorized: true,
        agent: false, maxHeaderSize: 8192, minVersion: 'TLSv1.3',
      }, response => {
        if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/octet-stream') { fail(); response.destroy(); return; }
        response.on('data', (chunk: Buffer) => {
          if (settled) { chunk.fill(0); return; }
          size += chunk.length;
          if (size > limit) { chunk.fill(0); fail(); response.destroy(); request.destroy(); }
          else chunks.push(chunk);
        });
        response.on('error', fail); response.on('aborted', fail);
        response.on('end', () => {
          if (settled) { erase(); return; }
          if (!size) { fail(); return; }
          settled = true; const bytes = Buffer.concat(chunks); erase(); resolve(bytes);
        });
      });
      // Absolute deadline, including connect/TLS/slow streaming, not an inactivity timeout.
      const deadline = setTimeout(() => { fail(); request.destroy(); }, 5000);
      request.on('close', () => clearTimeout(deadline));
      request.on('error', fail); request.end();
    }).catch(() => { throw failed(); });
  }
  return {
    async read(name) {
      if (!secretName.safeParse(name).success) throw failed();
      return acquire(`/v1/value/${name}`, LIMIT);
    },
    async generation() {
      const bytes = await acquire('/v1/generation', 36);
      try {
        const generation = Buffer.from(bytes).toString('ascii');
        if (bytes.length !== 36 || !generationPattern.test(generation) || !Buffer.from(generation).equals(Buffer.from(bytes))) throw failed();
        return generation;
      } finally { bytes.fill(0); }
    },
  };
}
/** Run in the holder process. The provider is crypto-only and returns owned bytes.
 * Refuses existing sockets; restart cleanup is an explicit operator step.
 */
export async function listenLocalHolder(config: Omit<LocalHolderConfig, 'servername'>, source: SecretValueSource & Partial<HolderGeneration>, daemonFingerprint?: string) {
  if (!isAbsolute(config.socket)) throw failed();
  assertPrivateDirectory(dirname(config.socket));
  const {key, cert, ca} = tlsMaterial(config);
  const server = https.createServer({key, cert, ca, requestCert: true, rejectUnauthorized: true,
    maxHeaderSize: 8192, minVersion: 'TLSv1.3'}, async (req, res) => {
    let bytes: Uint8Array | undefined;
    res.on('error', () => {});
    try {
      const peer = req.socket as TLSSocket;
      if (daemonFingerprint && (!peer.authorized || peer.getPeerCertificate().fingerprint256 !== daemonFingerprint)) throw failed();
      const match = /^\/v1\/value\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(req.url ?? '');
      const generation = req.url === '/v1/generation';
      if (req.method !== 'GET' || (!match && !generation) || req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) throw failed();
      if (generation) {
        const marker = await source.generation?.();
        if (typeof marker !== 'string' || marker.length !== 36 || !generationPattern.test(marker)) throw failed();
        bytes = Buffer.from(marker);
      } else bytes = await source.read(match![1]);
      if (res.destroyed || !bytes.length || bytes.length > LIMIT) throw failed();
      res.writeHead(200, {'content-type':'application/octet-stream', 'cache-control':'no-store', 'content-length':bytes.length});
      // Keep ownership until Node has finished copying/flushing the supplied bytes.
      await new Promise<void>(done => { res.once('close', done); res.end(bytes, done); });
    } catch { if (!res.headersSent) res.writeHead(503, {'content-length':0}); res.end(); }
    finally { bytes?.fill(0); }
  });
  // Bound accepted sockets before TLS/headers, rather than Node's coarse HTTP timer.
  server.on('connection', socket => {
    const deadline = setTimeout(() => socket.destroy(), 5000);
    socket.once('close', () => clearTimeout(deadline));
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve); });
    chmodSync(config.socket, 0o600);
  } catch { server.close(); throw failed(); }
  return { async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(failed()) : resolve())); } };
}
