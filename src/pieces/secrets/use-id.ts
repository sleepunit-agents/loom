/** The id of one private use of a secret by a job. loom makes it, the worker reads it back from a header
 * and confirms with it; the maker and both checks of its shape are here. */
import { createHash } from 'node:crypto';

export const SECRET_USE_ID = /^use-input-[a-f0-9]{64}$/;
/** The same agent, job and attempt always give the same id, so a retried read is one use. */
export const secretUseId = (agent: string, job: string, attempt: string): string =>
  'use-input-' + createHash('sha256').update('loom-private-secret-input-v1\0').update(JSON.stringify([agent, job, attempt])).digest('hex');
