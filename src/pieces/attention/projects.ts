/** Composition over Mind's policy-filtered registry role, never its content store. */
import type { Viewer } from '../../core/index.js';
import type { Mind } from '../mind/role.js';
import type { DigestReferences } from './project-references.js';
interface ProjectReference {
  agent: string; slug: string; archived: boolean;
  card: { links: { aliases?: string[]; venues?: string[] } };
}
export function attentionProjects(mind: Mind): NonNullable<DigestReferences['projects']> {
  const read = (viewer: Viewer, agent: string) => {
    const result = mind.call(viewer, 'projectsList', {});
    if (!result.ok) return result;
    return { ok: true as const, value: (result.value as ProjectReference[]).filter(p => p.agent === agent && !p.archived) };
  };
  return {
    resolve(viewer, name, agent) {
      const result = read(viewer, agent);
      if (!result.ok) return result;
      const project = result.value.find(p => p.slug === name) ?? result.value.find(p => p.card.links.aliases?.includes(name));
      return { ok: true, value: project?.slug ?? null };
    },
    byVenue(viewer, venuePlace, agent) {
      const result = read(viewer, agent);
      if (!result.ok) return result;
      return { ok: true, value: result.value.filter(p => p.card.links.venues?.includes(venuePlace)).map(p => p.slug) };
    },
  };
}
