/** Worker-only local Docker Engine transport. No retries and no ambient socket. */
import { request } from 'node:http';
import type { Duplex, Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { plainPath } from './worker-mounts.js';
export interface DockerEngine {
  /** One request and its JSON answer. An answer longer than `limit` bytes is refused: one ordinary answer's
   * size unless the call says otherwise (a listing, LISTING_MAX). */
  json(method: string, path: string, body: unknown, signal: AbortSignal, limit?: number): Promise<unknown>;
  attach(id: string, signal: AbortSignal): Promise<Duplex>;
  /** Build an image from a tar context, streamed up as it comes. Resolves when the engine has finished
   * without reporting an error. The engine's own account of the build is read and dropped: it holds
   * whatever the build steps printed. Whoever calls asks afterwards whether the image is there. */
  build(path: string, context: Readable, signal: AbortSignal): Promise<void>;
}
export class DockerResponseError extends Error {
  constructor(readonly status: number) { super('Docker request failed'); }
}
/** The size of one answer from the container engine, and of one line of a build's account. */
const ANSWER_MAX = 65_536;
/** The size of a listing of images: each carries its labels, and there may be many. */
export const LISTING_MAX = 4_194_304;
export function dockerEngine(socketPath: string): DockerEngine {
  // How the path must be written is worker-mounts.ts's rule; the worker has checked there that it is a socket.
  if (!plainPath(socketPath)) throw new Error('Expected absolute Docker socket');
  return {
    json(method, path, body, signal, limit = ANSWER_MAX) {
      return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = request({ socketPath, method, path, signal,
          headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
          let size = 0; const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) res.destroy(new Error('Docker response exceeded limit'));
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
    build(path, context, signal) {
      return new Promise((resolve, reject) => {
        const failed = () => { context.destroy(); req.destroy(); reject(new Error('Docker build failed')); };
        const req = request({ socketPath, method: 'POST', path, signal, headers: { 'Content-Type': 'application/x-tar' } }, res => {
          // One JSON message a line. Only whether a line reports an error is kept; a line longer than one
          // answer may be is a build step's output and is skipped to its end.
          const decoder = new StringDecoder('utf8'); let line = '', skipping = false, error = false;
          const message = (text: string) => { try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && ('error' in value || 'errorDetail' in value)) error = true; } catch { /* not a message */ } };
          const read = (text: string) => {
            for (let rest = text; rest;) {
              const end = rest.indexOf('\n'), part = end < 0 ? rest : rest.slice(0, end);
              if (!skipping && line.length + part.length > ANSWER_MAX) { skipping = true; line = ''; }
              if (!skipping) line += part;
              if (end < 0) break;
              if (!skipping && line.trim()) message(line);
              line = ''; skipping = false; rest = rest.slice(end + 1);
            }
          };
          res.on('data', (chunk: Buffer) => read(decoder.write(chunk)));
          res.once('error', failed);
          res.once('aborted', failed);
          res.once('end', () => {
            read(decoder.end()); if (!skipping && line.trim()) message(line);
            // A build that did not work has no more use for its context: what feeds it is let go.
            if (res.statusCode !== 200) { context.destroy(); reject(new DockerResponseError(res.statusCode ?? 0)); return; }
            if (error) { context.destroy(); reject(new Error('Docker build failed')); } else resolve();
          });
        });
        req.once('error', failed);
        context.once('error', failed);
        context.pipe(req);
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
