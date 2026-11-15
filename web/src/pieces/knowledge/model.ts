import type { KnowledgeOpen } from '../../../../src/pieces/mind/knowledge';
export type Page = KnowledgeOpen & { id: string; [key: string]: unknown };
export const freshWord = { fresh: 'Fresh', aging: 'Getting old', due: 'Due a check' };
export const date = (s: string) => new Date(s).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });
export const inFolder = (page: Page, folder: string) => folder === 'all' || (folder === 'recent' ? !!page.recent : folder === 'due' ? page.fresh === 'due' : page.domain === folder.slice(2) || page.domain.startsWith(`${folder.slice(2)}/`));
export function shownPages(pages: readonly Page[], folder: string, query: string) {
  const needle = query.trim().toLowerCase();
  return pages.filter(p => needle ? `${p.title} ${p.domain}`.toLowerCase().includes(needle) : inFolder(p, folder))
    .sort((a,b) => folder === 'due' && !needle ? Date.parse(a.verified_at ?? a.updated) - Date.parse(b.verified_at ?? b.updated) : b.updated.localeCompare(a.updated) || a.slug.localeCompare(b.slug));
}
