import { OperationError } from '../../core/index.js';
import { secretName, type SecretUse } from '../secrets/role.js';
import type { Secrets } from './roles.js';

/** Validate explicit public forge owners and Secret names, never values. */
export function githubBindingNames(bindings: Readonly<Record<string, string>>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [owner, name] of Object.entries(bindings)) {
    const key = owner.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(key)
      || !secretName.safeParse(name).success || names.has(key)) {
      throw new OperationError('invalid', 'Invalid GitHub credential bindings');
    }
    names.set(key, name);
  }
  return names;
}

/** Trusted composition supplies the credential-use port; this mapping neither
 * discovers tokens nor grants any caller permission to read them. */
export function githubSecrets(use: SecretUse, bindings: Readonly<Record<string, string>>): Secrets {
  const names = githubBindingNames(bindings);
  const references = new Set(names.values());
  return {
    async resolveGitHub(owner) {
      const name = names.get(owner.toLowerCase());
      if (!name) throw new OperationError('unavailable', 'GitHub credential unavailable');
      return name;
    },
    async withValue(reference, callback) {
      if (!references.has(reference)) throw new OperationError('denied', 'GitHub credential unavailable');
      return use.withValue(reference, callback);
    },
  };
}
