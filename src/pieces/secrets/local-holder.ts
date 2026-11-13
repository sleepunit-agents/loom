/** Crypto-only local holder protocol. HTTPS is carried over a private Unix socket;
 * mutual TLS authenticates both peers before a name or value is sent. No TCP.
 */
import https from 'node:https';
import { constants, openSync, fstatSync, readFileSync, closeSync, lstatSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { SecretValueSource } from './service.js';
import { secretName } from './input.js';

const LIMIT = 64 * 1024;
const failed = () => new Error('Local secret holder unavailable');
/** Explicit private regular files only, opened without following a final symlink. */
export function privateBytes(path: string, limit = 64 * 1024): Buffer {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path)) throw failed();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.nlink !== 1 || s.size < 1 || s.size > limit) throw failed();
    const bytes = readFileSync(fd);
    if (bytes.length > limit) { bytes.fill(0); throw failed(); }
    return bytes;
  } catch { throw failed(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function privateDirectory(socket: string) {
  if (!isAbsolute(socket)) throw failed();
  const s = lstatSync(dirname(socket));
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw failed();
}
function privateSocket(socket: string) {
  privateDirectory(socket);
  const s = lstatSync(socket);
  if (!s.isSocket() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw failed();
}
export interface LocalHolderConfig {
  socket: string;
  /** Dedicated holder CA, client/server certificates and private key, not household credentials. */
  ca: string; cert: string; key: string;
  /** Holder certificate DNS identity, verified by Node TLS. */
  servername: string;
}
export function localSecretSource(config: LocalHolderConfig): SecretValueSource {
  const ca = privateBytes(config.ca), cert = privateBytes(config.cert), key = privateBytes(config.key);
  if (!config.servername || !isAbsolute(config.socket)) throw failed();
  return { async read(name) {
    if (!secretName.safeParse(name).success) throw failed();
    try { privateSocket(config.socket); } catch { throw failed(); }
    return new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0, settled = false;
      const erase = () => { for (const b of chunks) b.fill(0); };
      const fail = () => { if (settled) return; settled = true; erase(); reject(failed()); };
      const request = https.request({socketPath: config.socket, servername: config.servername,
        path: `/v1/value/${name}`, method: 'GET', ca, cert, key, rejectUnauthorized: true,
        agent: false, maxHeaderSize: 8192, minVersion: 'TLSv1.3',
      }, response => {
        if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/octet-stream') { fail(); response.destroy(); return; }
        response.on('data', (chunk: Buffer) => {
          if (settled) { chunk.fill(0); return; }
          size += chunk.length;
          if (size > LIMIT) { chunk.fill(0); fail(); response.destroy(); request.destroy(); }
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
    });
  }};
}
/** Run in the holder process. The provider is crypto-only and returns owned bytes.
 * Refuses existing sockets; restart cleanup is an explicit operator step.
 */
export async function listenLocalHolder(config: Omit<LocalHolderConfig, 'servername'>, source: SecretValueSource) {
  privateDirectory(config.socket);
  const key = privateBytes(config.key), cert = privateBytes(config.cert), ca = privateBytes(config.ca);
  const server = https.createServer({key, cert, ca, requestCert: true, rejectUnauthorized: true,
    maxHeaderSize: 8192, minVersion: 'TLSv1.3'}, async (req, res) => {
    let bytes: Uint8Array | undefined;
    res.on('error', () => {});
    try {
      const match = /^\/v1\/value\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(req.url ?? '');
      if (req.method !== 'GET' || !match || req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) throw failed();
      bytes = await source.read(match[1]);
      if (res.destroyed || !bytes.length || bytes.length > LIMIT) throw failed();
      res.writeHead(200, {'content-type':'application/octet-stream', 'cache-control':'no-store', 'content-length':bytes.length});
      // Keep ownership until Node has finished copying/flushing the supplied bytes.
      await new Promise<void>(done => { res.once('close', done); res.end(bytes, done); });
    } catch { if (!res.headersSent) res.writeHead(503, {'content-length':0}); res.end(); }
    finally { bytes?.fill(0); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve); });
    chmodSync(config.socket, 0o600);
  } catch { server.close(); throw failed(); }
  return { async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(failed()) : resolve())); } };
}
