/**
 * Write-time dedup key for memories (t-335).
 *
 * `remember()` always inserted — audit() found near-duplicates after the
 * fact (embedding similarity) but nothing caught a character-identical
 * restatement before it became a second row. This gives remember() a cheap
 * floor underneath audit/MMR: normalize (strip non-alphanumerics, lowercase)
 * and hash category+project+title+content, so an exact restatement collides
 * with the existing row's `uniq` value and reheats it instead of inserting.
 *
 * This only catches character-identical restatements (after normalization).
 * It is not a replacement for audit's similarity-based duplicate detection —
 * paraphrases, reworded titles, or trimmed content still need audit + merge.
 */
import { createHash } from 'node:crypto';

export interface UniqKeyInput {
  category: string;
  project?: string | null;
  title: string;
  content: string;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function computeUniqKey(input: UniqKeyInput): string {
  const basis = [
    normalize(input.category),
    normalize(input.project ?? ''),
    normalize(input.title),
    normalize(input.content),
  ].join('|');
  return createHash('sha256').update(basis, 'utf-8').digest('hex');
}
