import type { ReactNode } from 'react';
import { Chip } from '../../kit';

/** A reference the server found in a message (a task id, a pull request), as the one pattern that finds it again in
 * the message's words. Only plain ids are looked for, and never inside a longer word. */
export function refPattern(refs: readonly string[]): RegExp | undefined {
  const plain = [...new Set(refs)].filter(ref => /^[\w.:/#@-]{2,200}$/.test(ref)).sort((a, b) => b.length - a.length);
  return plain.length ? new RegExp(`(?<![\\w/#-])(${plain.map(ref => ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?![\\w/#-])`, 'g') : undefined;
}
/** Plain words with each reference drawn as a chip: one that opens its page where the app knows how. */
export function withRefs(text: string, refs: readonly string[], openRef?: (ref: string) => (() => void) | undefined): ReactNode {
  const pattern = refPattern(refs);
  if (!pattern) return text;
  return text.split(pattern).map((part, n) => n % 2 ? <Chip key={n} onClick={openRef?.(part)} label={openRef?.(part) ? `Open ${part}` : undefined}>{part}</Chip> : part);
}
