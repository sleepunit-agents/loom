import type { KnowledgeOpen, KnowledgeRow } from '../../../../src/pieces/mind/knowledge';
export type PageRow=KnowledgeRow & {id:string};
export type Page = KnowledgeOpen & { id: string; [key: string]: unknown };
export const freshWord = { fresh: 'Fresh', aging: 'Getting old', due: 'Due a check' };
/** "Nov 14": the day alone. In the household's zone where a caller passes it; Knowledge's own readings do not
 * carry one yet, so today it is the device's own (it was fixed to one zone before). */
export const date = (s: string, zone?: string) => {
  try { return new Date(s).toLocaleDateString('en-US', { timeZone: zone, month: 'short', day: 'numeric' }); }
  catch { return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
};
export const inFolder = (page: PageRow, folder: string) => folder === 'all' || (folder === 'recent' ? !!page.recent : folder === 'due' ? page.fresh === 'due' : page.domain === folder.slice(2) || page.domain.startsWith(`${folder.slice(2)}/`));
export function shownPages(pages: readonly PageRow[], folder: string, query: string) {
  const needle = query.trim().toLowerCase();
  return pages.filter(p => needle ? `${p.title} ${p.domain}`.toLowerCase().includes(needle) : inFolder(p, folder))
    .sort((a,b) => folder === 'due' && !needle ? Date.parse(a.verified_at ?? a.updated) - Date.parse(b.verified_at ?? b.updated) : b.updated.localeCompare(a.updated) || a.slug.localeCompare(b.slug));
}
