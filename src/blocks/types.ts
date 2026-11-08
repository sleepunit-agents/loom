/**
 * Shared block types for loom stack blocks.
 *
 * A "block" is a markdown file in the stack that an adapter loads during
 * the wake sequence — a harness manifest or a model manifest.
 * This module defines the common shape and a tiny frontmatter parser.
 * We intentionally avoid a YAML dep: frontmatter here is key: value lines,
 * small and strict.
 */

/** A single block read from disk. */
export interface Block {
  /** Filename without `.md`. Also the harness / model name. */
  key: string;
  /** Parsed frontmatter as flat key→value. Empty object when absent or malformed. */
  frontmatter: Record<string, string>;
  /** Markdown body after the frontmatter fences. Not trimmed — callers trim as needed. */
  body: string;
  /** Absolute path this block was read from. */
  path: string;
}

/** The common reader surface harness and model both implement. */
export interface BlockReader {
  /** Read a single block by key. Returns null when the file is missing or empty. */
  read(contextDir: string, key: string): Promise<Block | null>;
  /** Sorted list of keys present in this block's directory. */
  list(contextDir: string): Promise<string[]>;
  /** A blank template for this block type, parameterized by key. */
  template(key: string): string;
}

/**
 * Split `---` frontmatter from the markdown body. Missing or malformed
 * fences yield `{}` frontmatter + the original text as body. Individual
 * lines that aren't `key: value` are ignored.
 *
 * Normalizes CRLF → LF before parsing so files authored on Windows parse correctly.
 */
export function parseFrontmatter(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  // Normalize CRLF → LF so the regex works cross-platform.
  const normalized = text.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: text };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body: match[2] };
}
