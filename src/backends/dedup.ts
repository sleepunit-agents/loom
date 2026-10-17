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
 * Normalization is deliberately conservative (PR120 review): it only folds
 * differences that cannot change meaning in any script — Unicode
 * compatibility forms (NFKC), case, whitespace and punctuation (\p{P}).
 * Letters, combining marks and numbers in every script, and symbols (emoji,
 * operators, currency), are kept. The first version stripped everything
 * outside [a-z0-9], which reduced any CJK/Cyrillic/Arabic/... memory to the
 * empty string and made all of them collide — silent data loss.
 *
 * This only catches character-identical restatements (after normalization).
 * It is not a replacement for audit's similarity-based duplicate detection —
 * paraphrases, reworded titles, or trimmed content still need audit + merge.
 */
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

export interface UniqKeyInput {
  category: string;
  project?: string | null;
  title: string;
  content: string;
}

function normalize(text: string): string {
  const folded = text.normalize('NFKC').toLowerCase();
  const stripped = folded.replace(/[\p{P}\p{White_Space}]+/gu, '');
  // A field made only of punctuation ("...", "?!") would otherwise collapse
  // to "" and collide with every other punctuation-only field. Keep it
  // verbatim (minus surrounding whitespace) instead.
  return stripped.length > 0 ? stripped : folded.trim();
}

export function computeUniqKey(input: UniqKeyInput): string {
  // JSON array, not a delimiter join: no field content can alias a
  // different split of the same characters across fields.
  const basis = JSON.stringify([
    normalize(input.category),
    normalize(input.project ?? ''),
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
    .prepare('SELECT id, category, project, title, content, archived FROM memories ORDER BY id ASC')
    .all() as {
      id: number;
      category: string;
      project: string | null;
      title: string;
      content: string;
      archived: number;
    }[];
  const seen = new Set<string>();
  const update = db.prepare('UPDATE memories SET uniq = ? WHERE id = ?');
  db.transaction(() => {
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
