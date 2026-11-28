import { z } from 'zod';
import { SHA256_HEX } from '../core/sha256-hex.js';
import { COMMIT } from '../apps/merge-target.js';

/** What a worker reports of a frozen review's copy with the job's finish: the commit it holds, and the fingerprint of
 * every file, link and mode under it (review-snapshot.ts, snapshotFingerprint) before the body started and after it
 * ended. The two are the same unless something changed the copy: a read-only mount makes that a check, not a hope. */
export const reviewTreeReport = z.object({
  head: z.string().length(40).regex(COMMIT),
  before: z.string().length(64).regex(SHA256_HEX),
  after: z.string().length(64).regex(SHA256_HEX),
}).strict();
export type ReviewTreeReport = z.infer<typeof reviewTreeReport>;
