import { fullTime } from '../../kit/time';
/** Presentation of shared Inbox query rows; no store, policy or transport. */
export type InboxBody = { words: string; why?: string | null; ifYes?: string | null; ifNo?: string | null; link?: string | null };
export interface InboxItem {
  canSetVolume?: boolean; quietUntil?: string | null; canAnswer?: boolean; id: string; source: string; sourceId?: string | null; fromId?: string | null;
  agent?: string | null; project?: string | null; thread?: string | null; at: string;
  bodyKeepUntil?: string | null; answerKeepUntil?: string | null;
  state: 'waiting' | 'taken' | 'done' | 'answered' | 'resolved'; volume: 'full' | 'dim' | 'mute';
  answers?: 'yes-no' | 'words' | null; waitsOnKind?: string | null; waitsOnId?: string | null;
  body?: InboxBody | null; read: boolean; refs: readonly string[];
  answer?: string | null; answerText?: string | null; answeredBy?: string | null; answeredAt?: string | null; resolution?: string | null;
}
export interface InboxFolders { needs: number; alerts: number; answered: number; fyi: number; all: number; agents: readonly { id: string; count: number }[] }
/** `settling`: the rows and counts are the previous folder's, search's or page's, shown while the next loads.
 * `folder`: the folder the rows were read for, where the reading says; while settling it is still the last one. */
export interface InboxSnapshot { folders?: InboxFolders; status: 'live' | 'loading' | 'offline' | 'denied'; settling?: boolean; folder?: string; items: readonly InboxItem[] }
export type InboxAnswer = 'yes' | 'no' | 'words' | 'done' | 'dismiss';
export interface InboxActions {
  volume?(id: string, volume: InboxItem['volume']): Promise<void>;
  read?(id: string): Promise<void>;
  answer?(id: string, answer: InboxAnswer, words?: string): Promise<void>;
  openSource?(item: InboxItem): void;
  /** Where a reference (a task or approval id) opens, when the app knows; undefined leaves it a plain chip. */
  openRef?(ref: string): (() => void) | undefined;
}
// An approval request owns its question. A thread can ask a different question about
// that same approval, and a decision notice reports the answer in its own words.
export function approvalRequestId(item: InboxItem): string | undefined {
  return item.source === 'approval' && item.waitsOnKind === 'approval' ? item.waitsOnId ?? undefined : undefined;
}
export function managed(item: InboxItem): boolean {
  return (item.source === 'notice' && !!item.sourceId?.startsWith('worker-join:')) || !!item.waitsOnKind || ['task', 'approval', 'secret-request'].includes(item.source);
}
export function rows(snapshot: InboxSnapshot, folder: string, query: string): InboxItem[] {
  if (snapshot.status !== 'live') return [];
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return snapshot.items.filter(item => item.volume !== 'mute'
    && (folder === 'needs' ? item.state === 'waiting' && !!item.answers
      : folder === 'alerts' ? item.state === 'waiting' && item.source === 'notice' && !item.answers
      : folder === 'answered' ? ['answered', 'resolved', 'done'].includes(item.state)
      : folder === 'fyi' ? item.state === 'waiting' && !item.answers
      : folder.startsWith('agent:') ? item.agent === folder.slice(6) : true)
    && terms.every(term => [item.body?.words, item.body?.why, item.agent, item.project, item.source, ...item.refs].filter(Boolean).join(' ').toLowerCase().includes(term)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}

/** The stored state in plain words, said in this one place. A waiting item is open; one settled without an answer
 * (its task closed, its approval was decided) is settled. */
const stateWords: Record<InboxItem['state'], string> = { waiting: 'open', taken: 'in progress', done: 'done', answered: 'answered', resolved: 'settled' };
export const stateWord = (item: InboxItem) => stateWords[item.state] ?? item.state;
/** The stored answer in plain words. */
const answerWords: Record<string, string> = { yes: 'Yes', no: 'No', words: 'Answered in words', done: 'Marked done', dismiss: 'Dismissed', replied: 'Replied' };
export const answerWord = (answer: string) => answerWords[answer] ?? answer;
/** Who it is from. The Inbox's own data carries the agent's id, not its display name. */
export const from = (item: InboxItem) => item.agent ?? item.fromId ?? 'Loom';
/** How loudly an item is shown (stored as full, dim, mute). Full is listed whole and may notify this person's
 * devices. Dim is one line in the list and mute is left out of it; neither notifies, and both go back to full
 * at the item's quiet-until time. */
export const volumeWords: Record<InboxItem['volume'], string> = { full: 'Normal', dim: 'Quiet', mute: 'Hidden' };
export const volumeNote: Record<InboxItem['volume'], string> = { full: '', dim: 'One line in the list, no notifications', mute: 'Left out of the list, no notifications' };
/** The button that goes to where a managed question is answered, named by what it opens (never the stored kind). */
export function sourceLabel(item: InboxItem): string {
  const kind = item.waitsOnKind ?? item.source;
  return kind === 'task' ? 'Open the task' : kind === 'approval' ? 'Open in Approvals' : kind === 'secret-request' ? 'Open in Secrets' : 'Open where this is answered';
}
/** "Nov 14, 2026, 9:20 AM": the whole date and time, in the shared format (kit/time.ts) and the household's zone
 * where the caller has read it; the device's own without one. Never a zone's id or letters. */
export const when = (at: string, zone?: string): string => fullTime(at, zone);
