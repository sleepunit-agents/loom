/** Used only by the separate holder executable. No loom DB, policy, requests or
 * legacy secrets store. Explicit private age ciphertext directory and identity.
 */
import { Decrypter } from 'age-encryption';
import { join } from 'node:path';
import { privateBytes, assertPrivateDirectory } from './local-holder.js';
import { secretName } from './input.js';
import type { SecretValueSource } from './service.js';
export function ageSecretSource(directory: string, identityFile: string): SecretValueSource {
  const failed = () => new Error('Secret decryption unavailable');
  const check = () => {
    assertPrivateDirectory(directory);
  };
  const decrypt = new Decrypter();
  try {
    check(); const identity = privateBytes(identityFile);
    try { decrypt.addIdentity(identity.toString('utf8').trim()); } finally { identity.fill(0); }
  } catch { throw failed(); }
  return { async read(name) {
    let bytes: Uint8Array | undefined;
    try {
      if (!secretName.safeParse(name).success) throw failed();
      check();
      const ciphertext = privateBytes(join(directory, `${name}.age`), 128 * 1024);
      // Raw age STREAM has no compression: one <=64KiB plaintext chunk
      // requires <=64KiB+16 payload bytes, after header and 16-byte nonce.
      // Reject oversized ciphertext payload BEFORE the library allocates plaintext.
      const separator = ciphertext.indexOf('\n--- ');
      const headerEnd = separator < 0 ? -1 : ciphertext.indexOf(10, separator + 5);
      const payloadSize = ciphertext.length - headerEnd - 1 - 16;
      if (headerEnd < 0 || headerEnd >= 16 * 1024 || payloadSize <= 16 || payloadSize > 64 * 1024 + 16) throw failed();
      bytes = await decrypt.decrypt(ciphertext);
      if (!bytes.length || bytes.length > 64 * 1024) throw failed();
      return bytes;
    } catch { bytes?.fill(0); throw failed(); }
  }};
}
