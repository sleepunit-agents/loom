/**
 * Forget tool — removes memories by reference or by scope (category/project).
 *
 * Delegates to the configured memory backend for deletion.
 *
 * Guard grammar (store-convergence spec): scope deletions — category alone,
 * project alone, or title_pattern — require confirm: true. Without it the
 * call is a free dry-run that previews what would be deleted. Single-target
 * deletions (ref, or category+title) never need confirmation.
 */
import { createBackend } from '../backends/index.js';
import { globToMatcher } from '../backends/glob.js';
import type { ForgetInput } from '../backends/types.js';

export interface ForgetToolInput extends ForgetInput {
  /** Required true for scope (bulk) deletion. Omit for a dry-run preview. */
  confirm?: boolean;
}

const PREVIEW_TITLE_CAP = 10;

export async function forget(
  contextDir: string,
  input: ForgetToolInput,
): Promise<string> {
  const isSingle = input.ref || (input.category && input.title && !input.title_pattern);
  const isPatternBulk = !!input.title_pattern && (input.category || input.project);
  const isBulk = !isSingle && (input.category || input.project);

  if (input.title_pattern && !input.category && !input.project) {
    return 'title_pattern requires category or project as a scope guard. Provide at least one.';
  }

  if (!isSingle && !isBulk) {
    return 'Nothing to forget. Provide a ref, category+title, or a scope (category/project) for bulk deletion.';
  }

  const backend = createBackend(contextDir);

  // Scope deletion without confirm: free dry-run — preview, delete nothing.
  if (!isSingle && input.confirm !== true) {
    const entries = await backend.list({
      category: input.category,
      project: input.project,
      limit: 10_000,
    });
    const matched = input.title_pattern
      ? entries.filter((e) => globToMatcher(input.title_pattern!)(e.title))
      : entries;

    if (matched.length === 0) {
      return isPatternBulk
        ? `No memories matched pattern "${input.title_pattern}".`
        : 'No memories matched the given scope.';
    }

    const shown = matched
      .slice(0, PREVIEW_TITLE_CAP)
      .map((e) => `- ${e.ref} — ${e.title}`)
      .join('\n');
    const overflow = matched.length > PREVIEW_TITLE_CAP
      ? `\n…and ${matched.length - PREVIEW_TITLE_CAP} more`
      : '';
    const noun = matched.length === 1 ? 'memory' : 'memories';
    return (
      `Scope deletion requires confirm: true. Nothing was deleted.\n` +
      `This would delete ${matched.length} ${noun}:\n${shown}${overflow}\n` +
      `Re-call with the same arguments plus confirm: true to delete.`
    );
  }

  const { confirm: _confirm, ...backendInput } = input;
  const result = await backend.forget(backendInput);

  // Single deletion
  if (isSingle) {
    if (result.deleted.length === 0) {
      const identifier = input.ref ?? `${input.category}/${input.title}`;
      return `Memory not found: "${identifier}". Use recall to find the correct reference.`;
    }
    return `Memory forgotten: ${result.deleted[0]}`;
  }

  // Bulk deletion (including pattern-based)
  if (result.deleted.length === 0) {
    const desc = isPatternBulk
      ? `No memories matched pattern "${input.title_pattern}".`
      : 'No memories matched the given scope.';
    return desc;
  }
  return `Forgot ${result.deleted.length} memories:\n${result.deleted.map(r => `- ${r}`).join('\n')}`;
}
