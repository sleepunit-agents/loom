import type { Db } from '../../core/index.js';

/** Central household credential role, supplied by composition when available.
 * It must synchronously revoke every runner credential for box and every body
 * credential for jobs on this SAME connection/transaction. No file IO, network
 * calls or independent commits. Throwing rolls back the whole revocation.
 * Missing/already-revoked credentials count as success. Never returns secrets.
 */
export interface RuntimeCredentials {
  revokeBox(db: Db, input: { box: string; jobs: readonly string[]; now: number }): void;
  /** Revoke only this job's body credentials; retain its runner and other jobs. */
  revokeJob(db: Db, input: { job: string; now: number }): void;
}
