/**
 * Path-segment validation: a value that becomes one segment of a file path must be non-empty and free of
 * separators, wherever it is read. Without this a slug like "../../../home/user/secrets" walks out of the
 * folder it belongs to.
 */

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
