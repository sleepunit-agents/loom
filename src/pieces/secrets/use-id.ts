/** The id of one private use of a secret by a job. loom makes it, the worker reads it back from a header
 * and confirms with it; the maker and both checks of its shape are here. */
import { createHash } from 'node:crypto';
import { SHA256_HEX_WITHIN } from '../../core/sha256-hex.js';

export const SECRET_USE_ID = new RegExp(`^use-input-${SHA256_HEX_WITHIN}$`);
/** The same agent, job and attempt always give the same id, so a retried read is one use. */
export const secretUseId = (agent: string, job: string, attempt: string): string =>
  'use-input-' + createHash('sha256').update('loom-private-secret-input-v1\0').update(JSON.stringify([agent, job, attempt])).digest('hex');
