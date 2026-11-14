/** Pure encrypted git payload preparation. No git IO or publication authority. */
import { createHash } from 'node:crypto';
import type { encryptHouseholdBundle } from './backup-bundle.js';
import { planHouseholdBackupRetention } from './backup-retention.js';

type DrilledBundle = Awaited<ReturnType<typeof encryptHouseholdBundle>>;
export interface HouseholdGitPart { path: string; bytes: Buffer }
export interface HouseholdGitPayload {
  stamp: string;
  bytes: number;
  sha256: string;
  partBytes: number;
  parts: HouseholdGitPart[];
}
const partMaximum = 90 * 1024 * 1024;
const bundleMaximum = 897 * 1024 * 1024;
const failure = () => new Error('Household backup git payload failed');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function budget(partBytes: number) {
  if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > partMaximum) throw failure();
}
function paths(stamp: string, size: number, partBytes: number, maxBytes: number): string[] {
  planHouseholdBackupRetention([stamp], 1);
  budget(partBytes);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > bundleMaximum
    || !Number.isSafeInteger(size) || size < 1 || size > maxBytes) throw failure();
  const count = Math.ceil(size / partBytes);
  if (count > 100) throw failure(); // two decimal digits, including part-99
  const name = `bundles/loom-household-${stamp}.bundle`;
  return size <= partBytes ? [name] : Array.from({ length: count }, (_, i) => `${name}.part-${String(i).padStart(2, '0')}`);
}

/** Copy the actual registered exporter result into bounded git blobs. Exactly
 * the threshold stays unsplit; larger bundles use contiguous part-00..part-99.
 * partBytes may only lower the production 90 MiB ceiling (small test budgets).
 * maxBytes may only lower the 897 MiB total ceiling, including in verification.
 * Buffers are owned and independent from both producer and sibling parts.
 * Header/drill shape checks are NOT encryption, provenance or owner authority.
 * Only a trusted caller supplies the actual registered encrypted/drilled output.
 * This helper neither inspects a remote nor constructs, prunes or pushes a tree.
 */
export function prepareHouseholdGitPayload(stamp: string, bundle: DrilledBundle, partBytes = partMaximum, maxBytes = bundleMaximum): HouseholdGitPayload {
  try {
    if (bundle?.coverage !== 'explicit-household-inputs' || !Buffer.isBuffer(bundle.bytes)
      || ['app', 'continuity', 'files', 'cookieKey', 'secrets'].some(k => bundle.drill?.[k as keyof typeof bundle.drill] !== true)) throw failure();
    const names = paths(stamp, bundle.bytes.length, partBytes, maxBytes);
    if (!bundle.bytes.subarray(0, 22).equals(Buffer.from('age-encryption.org/v1\n'))) throw failure();
    const bytes = Buffer.from(bundle.bytes);
    const payload: HouseholdGitPayload = { stamp, bytes: bytes.length, sha256: hash(bytes), partBytes,
      parts: names.map((path, i) => ({ path, bytes: Buffer.from(bytes.subarray(i * partBytes, (i + 1) * partBytes)) })) };
    verifyHouseholdGitPayload(payload, bytes, maxBytes);
    return payload;
  } catch { throw failure(); }
}

/** Check materialized blob bytes in exact restore order against the original
 * drilled ciphertext, byte for byte, without allocating a concatenated copy.
 * Expected bytes must come from the trusted exporter, not payload metadata.
 * A future publisher must read back its actual git blobs and call this before
 * committing; checking the prepared in-memory parts alone proves no git IO.
 * Neither this return nor any mutable payload object is a capability/receipt.
 */
export function verifyHouseholdGitPayload(payload: HouseholdGitPayload, expected: Buffer, maxBytes = bundleMaximum): void {
  try {
    if (!Buffer.isBuffer(expected)) throw failure();
    const names = paths(payload.stamp, expected.length, payload.partBytes, maxBytes);
    if (payload.bytes !== expected.length || payload.sha256 !== hash(expected)
      || !Array.isArray(payload.parts) || payload.parts.length !== names.length) throw failure();
    let offset = 0;
    for (let i = 0; i < names.length; i++) {
      const part = payload.parts[i];
      const size = Math.min(payload.partBytes, expected.length - offset);
      if (part?.path !== names[i] || !Buffer.isBuffer(part.bytes) || part.bytes.length !== size
        || !part.bytes.equals(expected.subarray(offset, offset + size))) throw failure();
      offset += size;
    }
    if (offset !== expected.length) throw failure();
  } catch { throw failure(); }
}
