/** Private parent-to-fixed-child input. Never an assignment or receipt field. */
import type { WorkerAssignment } from './worker.js';
export interface BodyBootstrap { origin: string; job: string; token: Uint8Array; erase?: () => void }
/** Erases the bytes. The same value has also been a string on its way to the body and to loom, which
 * nothing can erase: docs/accepted-tradeoffs.md, "A body's credential and its tools bearer cannot be
 * erased from memory". */
export function eraseBootstrap(input: BodyBootstrap | undefined) { input?.token.fill(0); input?.erase?.(); }
export function bodyOrigin(value:string):URL {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\\\s@]+\/?$/.test(value)) throw new Error('Invalid private body origin');
  const origin=new URL(value);
  if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'
    ||origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))throw new Error('Invalid private body origin');
  return origin;
}
export function bodyInput(job: WorkerAssignment, build: string, bootstrap?: BodyBootstrap, acceptsBootstrap = false) {
  if (Boolean(bootstrap) !== acceptsBootstrap) throw new Error('Private body input mode differs');
  if (!bootstrap) return { job, build };
  if (!(bootstrap.token instanceof Uint8Array) || bootstrap.token.byteLength !== 69) throw new Error('Invalid private body input');
  const origin=bodyOrigin(bootstrap.origin);
  const token = Buffer.from(bootstrap.token.buffer, bootstrap.token.byteOffset, bootstrap.token.byteLength).toString('utf8');
  if (bootstrap.job !== job.id || !/^body_[a-f0-9]{64}$/.test(token)) throw new Error('Invalid private body input');
  return { job, build, bootstrap: { origin: origin.origin, job: bootstrap.job, token } };
}
