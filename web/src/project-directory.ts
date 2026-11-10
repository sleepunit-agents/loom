import type { ProjectCards, ProjectCardView } from '../../src/ui/project-cards';
import type { Rec } from './collections/runtime';

/** Directory fields come from the shared records. Feeds remain the page's own until their source migration. */
export function projectDirectory(cards: ProjectCards, records: ReadonlyMap<string, Rec> | null): ProjectCards {
  if (!records) return cards;
  const prior = new Map([...cards.active, ...cards.quiet].map((c) => [`${c.agent ?? ''}:${c.slug}`, c]));
  const active: ProjectCardView[] = [], quiet: ProjectCardView[] = [];
  for (const r of records.values()) {
    if (typeof r.agent !== 'string' || typeof r.slug !== 'string' || typeof r.name !== 'string'
      || typeof r.status !== 'string' || typeof r.activity !== 'string') continue;
    const old = prior.get(`${r.agent}:${r.slug}`);
    const c: ProjectCardView = { slug: r.slug, agent: r.agent || undefined, name: r.name, status: r.status,
      page: r.agent ? `projects/${r.agent}/${r.slug}` : `projects/${r.slug}`, activity: r.activity,
      repos: [], people: r.agent ? [{ name: r.agent, agent: r.agent }] : [], lately: [] };
    const links = r.links as { repos?: unknown } | undefined;
    if (Array.isArray(links?.repos)) c.repos = links.repos.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/^github:/, ''));
    if (old) c.what = old.what;
    if (r.status === 'active') {
      // A quiet card never had its feeds counted. Do not promote its absent count to "nothing waiting".
      if (old?.status === 'active') {
        c.waiting = old.waiting; c.lately = old.lately; c.people = old.people; c.spark = old.spark; c.changes = old.changes;
      } else c.waiting = { unknown: "Couldn't count what's waiting: its sections haven't been read yet." };
      active.push(c);
    } else quiet.push(c);
  }
  const rank = (c: ProjectCardView) => c.waiting && 'count' in c.waiting && c.waiting.count > 0 ? 0 : c.waiting && 'unknown' in c.waiting ? 1 : 2;
  active.sort((a, b) => rank(a) - rank(b) || Date.parse(b.activity) - Date.parse(a.activity));
  quiet.sort((a, b) => Date.parse(b.activity) - Date.parse(a.activity));
  return { active, quiet, waiting: active.reduce((n, c) => n + (c.waiting && 'count' in c.waiting ? c.waiting.count : 0), 0) };
}
