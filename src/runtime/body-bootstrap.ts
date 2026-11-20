/** Private parent-to-fixed-child input. Never an assignment or receipt field. */
import type { WorkerAssignment } from './worker.js';
import { BODY_TOKEN, BODY_TOKEN_BYTES } from './body-token.js';
import { privateOrigin } from '../core/private-origin.js';
export interface BodyBootstrap { origin: string; job: string; token: Uint8Array; erase?: () => void }
/** Erases the bytes. The same value has also been a string on its way to the body and to loom, which
 * nothing can erase: docs/accepted-tradeoffs.md, "A body's credential and its tools bearer cannot be
 * erased from memory". */
export function eraseBootstrap(input: BodyBootstrap | undefined) { input?.token.fill(0); input?.erase?.(); }
export function bodyInput(job: WorkerAssignment, build: string, bootstrap?: BodyBootstrap, acceptsBootstrap = false) {
  if (Boolean(bootstrap) !== acceptsBootstrap) throw new Error('Private body input mode differs');
  if (!bootstrap) return { job, build };
  if (!(bootstrap.token instanceof Uint8Array) || bootstrap.token.byteLength !== BODY_TOKEN_BYTES) throw new Error('Invalid private body input');
  let origin:URL;try{origin=privateOrigin(bootstrap.origin);}catch{throw new Error('Invalid private body origin');}
  const token = Buffer.from(bootstrap.token.buffer, bootstrap.token.byteOffset, bootstrap.token.byteLength).toString('utf8');
  if (bootstrap.job !== job.id || !BODY_TOKEN.test(token)) throw new Error('Invalid private body input');
  return { job, build, bootstrap: { origin: origin.origin, job: bootstrap.job, token } };
}
