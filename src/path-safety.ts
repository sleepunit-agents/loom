/**
 * Path-segment validation and atomic identity writes.
 *
 * Boundary discipline (store-convergence spec): any param that becomes a
 * file path segment (role, project, client, model, harness/model key)
 * validates non-empty and separator-free at every reader, not just some
 * writers. Without this, a value like "../../../home/user/secrets" walks
 * out of the context directory and reads arbitrary .md files into agent
 * context.
 *
 * Atomic identity writes (same spec): anything under the identity tier
 * (IDENTITY.md, preferences.md, self-model.md) writes via tmp+rename with
 * a single-generation `.bak` of the prior version. A crash mid-write must
 * never truncate the creed.
 */
import { copyFile } from 'node:fs/promises';
import { atomicWrite } from './injection/writer.js';

/**
 * Returns a human-readable error string when `value` cannot be used as a
 * single path segment, or null when it is safe. Rejects empty strings,
 * '.', '..', path separators (both / and \), and control characters.
 */
export function pathSegmentError(value: string, paramName: string): string | null {
  if (
    value === '' ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    // Control characters (NUL, newlines, …): a name that ends up inside a
    // file must not be able to start a new line there.
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    return (
      `Invalid ${paramName} ${JSON.stringify(value)}: ` +
      'must be a non-empty name with no path separators or control characters.'
    );
  }
  return null;
}

/**
 * Throwing variant of pathSegmentError — for block-level readers whose
 * contract is to throw. Tool-layer functions that return error strings
 * should call pathSegmentError directly instead.
 */
export function assertSafePathSegment(value: string, paramName: string): void {
  const error = pathSegmentError(value, paramName);
  if (error) throw new Error(error);
}

/**
 * Write an identity-tier file atomically (tmp + rename). When the file
 * already exists, its prior content is preserved as `<path>.bak` first —
 * single generation, overwriting any older .bak. First-ever writes
 * produce no .bak.
 */
export async function atomicWriteWithBackup(path: string, content: string): Promise<void> {
  let existed = true;
  try {
    await copyFile(path, `${path}.bak`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    existed = false;
  }
  await atomicWrite(path, content, existed ? path : null);
}
