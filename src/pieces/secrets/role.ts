/** What other pieces may depend on from Secrets: the name rule and the shapes through which a value is used. */
export { secretName } from './input.js';
export type { HolderGeneration } from './local-holder.js';
/** Hands out a secret's bytes. The caller gets a fresh buffer it owns, and must never log it or keep a
 * plaintext copy. */
export interface SecretValueSource { read(name: string): Promise<Uint8Array> }
/** Use of one named secret for the length of a callback; the value does not outlive it. */
export interface SecretUse {
  withValue<T>(name: string, use: (token: string) => Promise<T>): Promise<T>;
}
