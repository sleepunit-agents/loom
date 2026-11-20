/** A file's name made plain, for wherever loom or a body puts a file an outside person or a model named:
 * letters, digits, `.`, `_` and `-` only, no leading dot, never empty, cut to a length. One rule for a kept
 * Slack or Discord attachment, a file written for a body, and a file on a post. No imports, so a body can
 * load it. */
export const plainFileName = (name: string, max = 80): string => name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, max).replace(/^[._]+/, '') || 'file';
