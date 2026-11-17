/** One worker for one engine and for one sign-in directory, held by the machine and not by good manners.
 *
 * Two things a worker with container bodies does are right only when no other worker does them beside it:
 * it builds the core house once for an engine and removes the core houses nothing of its own is built on,
 * and it counts the bodies that share one account's sign-in. So before it takes any work it holds each of
 * those to itself: its engine's socket and every sign-in directory its configuration names, each by its
 * real path. A second worker that names one of them, whatever its own state directory or configuration
 * file, cannot hold it too and stops (WorkerStop 'shared').
 *
 * What is held is a name in the system's own table of listening sockets, made from the path's digest. On
 * Linux it is an abstract socket: no file anywhere, nothing inside the sign-in directory, taken or
 * refused in one step, and gone the moment the process that holds it is, however it ended. The name is
 * the same for every user of the machine, so two users' workers on one engine socket collide as they
 * should. It is the machine's network namespace's own: a worker in a container with a network of its own
 * shares nothing here, and is another machine as far as this goes. Elsewhere it is a socket file in the
 * temporary directory, by user; one a dead worker left is told from a live one by trying to reach it.
 *
 * Nobody ever connects to these sockets, and nothing is read from them. */
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { WorkerStop } from './worker-stop.js';

/** One thing to hold: the configuration key that names it, for the line a second worker stops with, and
 * the real path that is held. */
export interface Alone { key: string; path: string }
export type HoldAlone = (wanted: readonly Alone[]) => Promise<() => void>;
const DIGITS = 32;
const nameOf = (path: string) => `loom-worker-${createHash('sha256').update(path).digest('hex').slice(0, DIGITS)}`;
const listening = (address: string) => new Promise<Server | undefined>((resolve, reject) => {
  const server = createServer(socket => socket.destroy());
  server.once('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EADDRINUSE') resolve(undefined); else reject(error); });
  server.listen(address, () => { server.unref(); resolve(server); });
});
/** Whether something answers at this socket file. */
const answered = (file: string) => new Promise<boolean>(resolve => {
  const socket = connect(file);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
async function hold(path: string, abstract: boolean): Promise<Server | undefined> {
  if (abstract) return listening(`\0${nameOf(path)}`);
  const file = join(tmpdir(), `${nameOf(path)}-${userInfo().uid}.sock`);
  const first = await listening(file);
  if (first || await answered(file)) return first;
  // A file a dead worker left: nothing answers there. It is removed and the name taken afresh.
  rmSync(file, { force: true });
  return listening(file);
}
/** Hold every one of these to this process, or none.
 * @returns what gives them up. A process that ends without calling it gives them up by ending.
 * @throws WorkerStop 'shared', with the key of the first one another worker holds. */
export async function holdAlone(wanted: readonly Alone[], abstract = process.platform === 'linux'): Promise<() => void> {
  const held: Server[] = [], release = () => { for (const server of held.splice(0)) server.close(); };
  // One path named under two keys of one configuration is held once.
  const paths = new Set<string>();
  try {
    for (const { key, path } of wanted) {
      if (paths.has(path)) continue;
      const server = await hold(path, abstract);
      if (!server) throw new WorkerStop('shared', key);
      paths.add(path); held.push(server);
    }
  } catch (error) { release(); throw error; }
  return release;
}
