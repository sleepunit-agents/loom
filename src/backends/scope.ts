/**
 * Memory scope discipline (t-337b, from the 2026-09-01 affaan-m/ECC teardown).
 *
 * loom has always carried a `project` tag on memories, but nothing stopped a
 * preference learned while working on one project from surfacing while the
 * agent is working on an unrelated one — the tag was metadata, not a filter.
 *
 * Every memory now has an *effective scope*: 'project' (only visible when
 * recalling within the project it was written for) or 'global' (visible
 * everywhere). ECC's instinct-promotion model is the source: default to the
 * narrower scope, promote to global only on deliberate signal — here, an
 * explicit `scope` at write time, since loom has no cross-project id to
 * watch for repetition against.
 *
 * The category split below follows ECC's scope-decision table as far as
 * loom's own category vocabulary lets it: 'user' (a fact about the person)
 * and 'reference' (a pointer to an external system) are inherently
 * cross-project, so they default global even when a project happens to be
 * attached. Every other category defaults to 'project' — including 'self'
 * and 'feedback', where ECC's real split lives (language/framework/style/
 * error-handling feedback is project-specific; security/git/tool-workflow
 * feedback is universal). Category alone can't tell those apart; that's a
 * per-memory authoring call, made with `scope: 'global'` at write time, not
 * a product decision this module can bake in — see t-337's comment thread
 * for the open question on backfilling existing records.
 */

/** A memory's visibility: 'project' (scoped) or 'global' (everywhere). */
export type MemoryScope = 'project' | 'global';

/**
 * Default scope by category, applied only when a memory carries a project
 * tag. An untagged memory has nothing to scope against and is global by
 * construction — see `effectiveScope`.
 */
const CATEGORY_DEFAULT_SCOPE: Record<string, MemoryScope> = {
  user: 'global',
  reference: 'global',
  project: 'project',
  pursuit: 'project',
  episode: 'project',
  self: 'project',
  feedback: 'project',
};

/** Default scope for a category, 'project' for anything not in the table (safe default). */
export function defaultScopeForCategory(category: string): MemoryScope {
  return CATEGORY_DEFAULT_SCOPE[category] ?? 'project';
}

/** The subset of a memory record that scope decisions need. */
export interface ScopableMemory {
  category: string;
  project?: string | null;
  /** Explicit author override from write time, if any. Anything else is ignored (treated as unset). */
  scope?: string | null;
}

/**
 * The scope actually in force for a memory: the explicit override if one was
 * set at write time, else the category default — but only when the memory
 * is tagged to a project at all. A memory with no project has nothing to
 * scope against and is global regardless of category.
 */
export function effectiveScope(mem: ScopableMemory): MemoryScope {
  if (mem.scope === 'project' || mem.scope === 'global') return mem.scope;
  if (!mem.project) return 'global';
  return defaultScopeForCategory(mem.category);
}

/**
 * Recall-time enforcement: is `mem` visible to a caller currently working
 * within `recallProject`?
 *
 * `recallProject` null/undefined means the caller isn't scoping their recall
 * to a project — there is nothing to enforce, so every memory stays visible
 * (unchanged pre-t-337 behaviour: an unscoped recall searches everything).
 * Once a project is given: memories tagged to that exact project are always
 * visible, everything else is visible only if its effective scope is
 * 'global'.
 */
export function isVisibleInProject(
  mem: ScopableMemory,
  recallProject: string | null | undefined,
): boolean {
  if (!recallProject) return true;
  if ((mem.project ?? null) === recallProject) return true;
  return effectiveScope(mem) === 'global';
}
