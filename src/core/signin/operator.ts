/** Local OS-owner capability: one bounded link request per connection, no database client. */
import { LOGIN_PATH } from '../sha256-hex.js';
import { createServer, createConnection, type Socket } from 'node:net';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { assertHomeReady } from '../home-state.js';
import { LINK_MS } from './link-lifetime.js';
/** `member` may be left out: the issuer then signs in a current household owner (src/shared-startup.ts).
 * `ttl` is in seconds, at most a link's own lifetime. `agent` says the link is for an automated browser,
 * which gets the short session and may not make links or add passkeys, whatever it calls itself. */
export const operatorRequest = z.strictObject({
  request: z.literal('link'), member: z.string().min(1).max(200).optional(),
  label: z.string().max(200).default('Local sign-in'), ttl: z.number().int().min(1).max(LINK_MS / 1000).default(LINK_MS / 1000),
  agent: z.boolean().default(false),
});
const LIMIT = 4096;
function owned(path: string, mode: number | undefined, directory: boolean) {
  const st = lstatSync(path);
  if (process.getuid === undefined || st.uid !== process.getuid() || (mode !== undefined && (st.mode & 0o7777) !== mode) || (directory ? !st.isDirectory() : !st.isSocket())) throw new Error('Unsafe operator path');
}
export function checkOperatorHome(home: string) { owned(home, 0o700, true); }
export function prepareOperatorHome(home: string) {
  assertHomeReady(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const st = lstatSync(home);
  if (process.getuid === undefined || !st.isDirectory() || st.uid !== process.getuid()) throw new Error('Operator home must belong to this OS user');
  chmodSync(home, 0o700); checkOperatorHome(home);
}
function checkSocket(home: string) { checkOperatorHome(home); owned(join(home, 'operator.sock'), 0o600, false); }
/** The OS-owned transport; the issuer owns data. The home lifetime lock has already excluded any other
 * program on this home, so a socket left at the path is stale and is removed. */
export async function listenOperatorLinks(home: string, url: string, issue: (input: z.infer<typeof operatorRequest>) => string) {
  const dir = resolve(home), path = join(dir, 'operator.sock');
  checkOperatorHome(dir);
  try { owned(path, undefined, false); unlinkSync(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    let data = Buffer.alloc(0), done = false;
    socket.on('data', chunk => {
      if (done) return;
      data = Buffer.concat([data, Buffer.from(chunk)]);
      if (data.length > LIMIT) { done = true; socket.end('{"ok":false}\n'); return; }
      const end = data.indexOf(10); if (end === -1) return;
      done = true;
      try {
        checkSocket(dir);
        if (end !== data.length - 1) throw new Error('One request only');
        const input = operatorRequest.parse(JSON.parse(data.subarray(0, end).toString('utf8')));
        const path = issue(input);
        socket.end(JSON.stringify({ ok: true, path, url }) + '\n');
      } catch { socket.end('{"ok":false}\n'); }
    });
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(ok => server.close(() => ok()));
    // net.Server removes its own socket on close; never remove a replacement path.
  };
  try {
    await new Promise<void>((ok, no) => { server.once('error', no); server.listen(path, () => { server.off('error', no); ok(); }); });
    chmodSync(path, 0o600);
  } catch (e) { await close(); throw e; }
  return { close };
}
/** No retry: an interrupted response may already have made a link. */
export async function requestLocalLink(home: string, input: unknown): Promise<{ path: string; url: string }> {
  const dir = resolve(home); checkSocket(dir);
  const body = operatorRequest.parse(input);
  return new Promise((ok, no) => {
    const socket = createConnection(join(dir, 'operator.sock'));
    let data = Buffer.alloc(0), finished = false;
    const fail = () => { if (!finished) { finished = true; socket.destroy(); no(new Error('Local sign-in refused')); } };
    socket.on('error', fail); socket.once('end', () => { if (!finished) fail(); });
    socket.setTimeout(5000, fail);
    socket.once('connect', () => {
      try { checkSocket(dir); socket.write(JSON.stringify(body) + '\n'); } catch { fail(); }
    });
    socket.on('data', chunk => {
      data = Buffer.concat([data, Buffer.from(chunk)]); if (data.length > LIMIT) { fail(); return; }
      if (!data.includes(10)) return;
      try {
        const answer = JSON.parse(data.toString('utf8'));
        if (!answer.ok || typeof answer.path !== 'string' || !LOGIN_PATH.test(answer.path) || typeof answer.url !== 'string') throw new Error();
        finished = true; socket.destroy(); ok({ path: answer.path, url: answer.url });
      } catch { fail(); }
    });
  });
}
