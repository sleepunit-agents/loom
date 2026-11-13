/** Used only by the separate holder executable. No loom DB, policy, requests or
 * legacy secrets store. Explicit private age ciphertext directory and identity.
 */
import { Decrypter } from 'age-encryption';
import { join, isAbsolute } from 'node:path';
import { lstatSync } from 'node:fs';
import { privateBytes } from './local-holder.js';
import { secretName } from './input.js';
import type { SecretValueSource } from './service.js';
export function ageSecretSource(directory: string, identityFile: string): SecretValueSource {
  const failed = () => new Error('Secret decryption unavailable');
  const check = () => {
    const s = lstatSync(directory);
    if (!isAbsolute(directory) || !s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw failed();
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
      bytes = await decrypt.decrypt(ciphertext);
      if (!bytes.length || bytes.length > 64 * 1024) throw failed();
      return bytes;
    } catch { bytes?.fill(0); throw failed(); }
  }};
}
