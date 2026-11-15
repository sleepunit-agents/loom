/** Worker-only local Docker Engine transport. No retries and no ambient socket. */
import { request } from 'node:http';
import type { Duplex } from 'node:stream';
export interface DockerEngine {
  json(method: string, path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
  attach(id: string, signal: AbortSignal): Promise<Duplex>;
}
export class DockerResponseError extends Error {
  constructor(readonly status: number) { super('Docker request failed'); }
}
export function dockerEngine(socketPath: string): DockerEngine {
  if (!socketPath.startsWith('/') || socketPath.includes('\0')) throw new Error('Expected absolute Docker socket');
  return {
    json(method, path, body, signal) {
      return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = request({ socketPath, method, path, signal,
          headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
          let size = 0; const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 65_536) res.destroy(new Error('Docker response exceeded limit'));
            else chunks.push(chunk);
          });
          res.once('error', reject);
          res.once('aborted', () => reject(new Error('Docker response interrupted')));
          res.once('end', () => {
            // A missing container on force-removal is already reaped.
            if (method === 'DELETE' && res.statusCode === 404) { resolve(undefined); return; }
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { reject(new DockerResponseError(res.statusCode ?? 0)); return; }
            try { const text = Buffer.concat(chunks).toString('utf8'); resolve(text ? JSON.parse(text) : undefined); }
            catch { reject(new Error('Invalid Docker response')); }
          });
        });
        req.once('error', reject); req.end(data);
      });
    },
    attach(id, signal) {
      return new Promise((resolve, reject) => {
        const req = request({ socketPath, method: 'POST',
          path: `/containers/${encodeURIComponent(id)}/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=0`,
          signal, headers: { Connection: 'Upgrade', Upgrade: 'tcp' } });
        req.once('upgrade', (res, socket, head) => {
          if (res.statusCode !== 101) { socket.destroy(); reject(new Error('Docker attach failed')); return; }
          // The executor owns the upgraded socket, including cancellation.
          if (head.length) socket.unshift(head);
          resolve(socket);
        });
        req.once('response', res => { res.resume(); reject(new Error('Docker attach did not upgrade')); });
        req.once('error', reject); req.end();
      });
    },
  };
}
