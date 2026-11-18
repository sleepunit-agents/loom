import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Approval details can be read by the asking agent. Only the owner's proposal view opens this
 * snapshot, which may contain the entire contents of a file in the configured checkout.
 * The nonce and target are part of the key derivation so another card cannot reuse the snapshot. */
function reviewKey(digest: (text: string) => string, target: string, nonce: string) {
  return Buffer.from(digest('trigger-machine-review-v1\0' + JSON.stringify([target, nonce])), 'hex');
}

export function sealMachineReview(text: string, digest: (text: string) => string, target: string, nonce: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', reviewKey(digest, target, nonce), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function openMachineReview(snapshot: string, digest: (text: string) => string, target: string, nonce: string) {
  const bytes = Buffer.from(snapshot, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', reviewKey(digest, target, nonce), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
