/** Composition supplies new-side roles; no legacy store or caller-provided thread project. */
import { failure, type Failure, type Viewer } from '../../core/index.js';
import type { Conversation } from './conversations.js';
type Lookup<T> = { ok: true; value: T } | Failure;
export interface DigestReferences {
  /** Only live projects visible to this viewer. Null means no such visible name. */
  projects?: {
    resolve(viewer: Viewer, name: string, agent: string): Lookup<string | null>;
    byVenue(viewer: Viewer, venuePlace: string, agent: string): Lookup<string[]>;
  };
  /** Comms supplies the visible thread's canonical project; null for other conversations. */
  threadProject?(viewer: Viewer, conversation: Conversation): Lookup<string | null>;
}
export function digestProjects(viewer: Viewer, conversation: Conversation, names: string[], roles: DigestReferences): Lookup<string[]> {
  const projects = roles.projects;
  // The old no-Projects case retains names and performs no fallback.
  if (!projects) return { ok: true, value: [...new Set(names)] };
  const resolved: string[] = [];
  for (const name of names) {
    const result = projects.resolve(viewer, name, conversation.agent);
    if (!result.ok) return result;
    if (result.value === null) return failure('invalid', 'Project name is not a visible live project');
    if (!resolved.includes(result.value)) resolved.push(result.value);
  }
  if (resolved.length) return { ok: true, value: resolved };
  if (roles.threadProject) {
    const thread = roles.threadProject(viewer, conversation);
    if (!thread.ok) return thread;
    if (thread.value) {
      const result = projects.resolve(viewer, thread.value, conversation.agent);
      if (!result.ok) return result;
      if (result.value === thread.value) return { ok: true, value: [thread.value] };
    }
  }
  const venues = projects.byVenue(viewer, `${conversation.venue}:${conversation.place}`, conversation.agent);
  if (!venues.ok) return venues;
  return { ok: true, value: venues.value.length === 1 ? venues.value : [] };
}
