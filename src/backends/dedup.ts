/**
 * Write-time dedup key for memories (t-335).
 *
 * `remember()` always inserted — audit() found near-duplicates after the
 * fact (embedding similarity) but nothing caught a character-identical
 * restatement before it became a second row. This gives remember() a cheap
 * floor underneath audit/MMR: normalize and hash category+project+title+content,
 * so an exact restatement collides with the existing row's `uniq` value and
 * reheats it instead of inserting.
 *
 * Normalization is deliberately minimal (PR120 review, two rounds). The key
 * must only fold differences that can never change what a memory says, and
 * almost every character can: a sign ("-5" vs "5"), a decimal point ("1.5"
 * vs "15"), a hyphen in an identifier ("foo-bar" vs "foobar"), a space
 * ("foo bar" vs "foobar"), case ("US" vs "us"), a compatibility form ("x²"
 * vs "x2"), indentation in a code snippet. Earlier versions folded case and
 * punctuation (and, first, everything outside [a-z0-9]); each silently merged
 * distinct writes. What is folded now, in title and content only:
 *   - canonical Unicode equivalence (NFC — the same text, encoded two ways)
 *   - line-ending style (CRLF/CR → LF)
 *   - whitespace at the end of each line, and at the start/end of the field
 * category and project are not normalized at all: they are identifiers, so
 * they are compared exactly (missing project = empty string).
 *
 * The key also carries the memory's *effective* scope (backends/scope.ts):
 * restating a project-scoped memory with scope: 'global' is a different
 * write (it changes who can recall it), so it must not reheat the scoped
 * row and drop the promotion. An explicit scope equal to the category
 * default is the same write and still reheats.
 *
 * This only catches character-identical restatements (after normalization).
 * It is not a replacement for audit's similarity-based duplicate detection —
 * paraphrases, reworded titles, or trimmed content still need audit + merge.
 */
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { effectiveScope } from './scope.js';

export interface UniqKeyInput {
  category: string;
  project?: string | null;
  title: string;
  content: string;
  /** Explicit scope override, if any — folded to the effective scope. */
  scope?: string | null;
}

function normalize(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+$/gm, '')
    .trim();
}

export function computeUniqKey(input: UniqKeyInput): string {
  // JSON array, not a delimiter join: no field content can alias a
  // different split of the same characters across fields.
  const basis = JSON.stringify([
    input.category,
    input.project ?? '',
    effectiveScope(input),
    normalize(input.title),
    normalize(input.content),
  ]);
  return createHash('sha256').update(basis, 'utf-8').digest('hex');
}

/**
 * Recompute `uniq` for every row from its current category/project/title/
 * content with the current computeUniqKey(). Used by the migrations that
 * introduce or re-key the column.
 *
 * Archived rows get NULL — remember() only ever matches active rows, and
 * restore() recomputes the key when a row comes back. Among active rows,
 * oldest (lowest id) wins: if several already share a key (an unresolved
 * historical duplicate), only the first holds it and the rest stay NULL
 * rather than pointing a future reheat at an arbitrary survivor. Those
 * clusters are what memory_audit + memory_merge are for.
 */
export function rebuildUniqKeys(db: Database): void {
  const rows = db
    .prepare(
      // scope only exists from add_scope on; a DB that predates it has no
      // explicit overrides, so NULL (category default) is exact.
      `SELECT id, category, project, title, content, archived,
              ${hasScopeColumn(db) ? 'scope' : 'NULL AS scope'}
       FROM memories ORDER BY id ASC`,
    )
    .all() as {
      id: number;
      category: string;
      project: string | null;
      title: string;
      content: string;
      archived: number;
      scope: string | null;
    }[];
  const seen = new Set<string>();
  const update = db.prepare('UPDATE memories SET uniq = ? WHERE id = ?');
  db.transaction(() => {
    // Clear every key first. Rekeying row by row in place could otherwise
    // write a row's new key while a later row still holds it as a stale old
    // key, and trip the unique index on active rows.
    db.prepare('UPDATE memories SET uniq = NULL').run();
    for (const row of rows) {
      let key: string | null = null;
      if (row.archived === 0) {
        const k = computeUniqKey(row);
        if (!seen.has(k)) {
          seen.add(k);
          key = k;
        }
      }
      update.run(key, row.id);
    }
  })();
}

function hasScopeColumn(db: Database): boolean {
  const info = db.pragma('table_info(memories)') as { name: string }[];
  return info.some((c) => c.name === 'scope');
}
