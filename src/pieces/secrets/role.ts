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

/** A holder's generation is a version-4 UUID. Everything that is handed one checks it here. */
export const isHolderGeneration = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
