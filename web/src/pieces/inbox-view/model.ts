/** Presentation of shared Inbox query rows; no store, policy or transport. */
export type InboxBody = { words: string; why?: string | null; ifYes?: string | null; ifNo?: string | null; link?: string | null };
export interface InboxItem {
  id: string; source: string; sourceId?: string | null; fromId?: string | null;
  agent?: string | null; project?: string | null; thread?: string | null; at: string;
  bodyKeepUntil?: string | null; answerKeepUntil?: string | null;
  state: 'waiting' | 'taken' | 'done' | 'answered' | 'resolved'; volume: 'full' | 'dim' | 'mute';
  answers?: 'yes-no' | 'words' | null; waitsOnKind?: string | null; waitsOnId?: string | null;
  body?: InboxBody | null; read: boolean; refs: readonly string[];
  answer?: string | null; answerText?: string | null; answeredBy?: string | null; answeredAt?: string | null; resolution?: string | null;
}
export interface InboxFolders { needs: number; answered: number; fyi: number; all: number; agents: readonly { id: string; count: number }[] }
export interface InboxSnapshot { folders?: InboxFolders; status: 'live' | 'loading' | 'offline' | 'denied'; items: readonly InboxItem[] }
export type InboxAnswer = 'yes' | 'no' | 'words' | 'done' | 'dismiss';
export interface InboxActions {
  read?(id: string): Promise<void>;
  answer(id: string, answer: InboxAnswer, words?: string): Promise<void>;
  openSource?(item: InboxItem): void;
}
export function managed(item: InboxItem): boolean {
  return !!item.waitsOnKind || ['task', 'approval', 'secret-request'].includes(item.source);
}
export function rows(snapshot: InboxSnapshot, folder: string, query: string): InboxItem[] {
  if (snapshot.status !== 'live') return [];
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return snapshot.items.filter(item => item.volume !== 'mute'
    && (folder === 'needs' ? item.state === 'waiting' && !!item.answers
      : folder === 'answered' ? ['answered', 'resolved', 'done'].includes(item.state)
      : folder === 'fyi' ? item.state === 'waiting' && !item.answers
      : folder.startsWith('agent:') ? item.agent === folder.slice(6) : true)
    && terms.every(term => [item.body?.words, item.body?.why, item.agent, item.project, item.source, ...item.refs].filter(Boolean).join(' ').toLowerCase().includes(term)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}
