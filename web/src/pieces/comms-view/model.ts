/** Canonical Comms rows supplied by shared queries, with conversation labels
 * joined to each thread. These types own no store or transport. */
export interface CommsThread {
  id: string; conversation: string; title: string; agent: string; project?: string | null; member: string;
  pinned: boolean; archivedAt?: string | null; lastAt: string; readSeq: number;
  working: boolean; stopRequested: boolean;
}
export interface CommsMessage {
  thread: string; seq: number; kind: 'message' | 'reply' | 'card' | 'ask' | 'answer' | 'notice';
  sender: string; at: string; words: string | null; inboxItem?: string | null;
  verdict?: 'yes' | 'no' | null; tool?: string | null; cardState?: 'running' | 'done' | 'failed' | null;
  delivery?: 'sending' | 'held' | 'failed' | 'delivered' | null;
}
export type Status = 'live' | 'loading' | 'offline' | 'denied';
export interface CommsSnapshot { status: Status; member: string; threads: readonly CommsThread[]; agents: readonly { id: string; name: string }[] }
export interface CommsDetail { status: Status; thread: CommsThread | null; messages: readonly CommsMessage[]; refs: readonly { ref: string; messageSeq: number }[] }
export type ThreadChange = { change: 'rename'; title: string } | { change: 'pin'; pinned: boolean } | { change: 'archive'; archived: boolean } | { change: 'stop' };
export interface CommsActions {
  open(agent: string, thread: string): Promise<void>;
  send(thread: string, words: string, clientId: string): Promise<void>;
  read(thread: string, seq: number): Promise<void>;
  change(thread: string, change: ThreadChange): Promise<void>;
}
export function threadRows(snapshot: CommsSnapshot, archived: boolean, query: string): CommsThread[] {
  if (snapshot.status !== 'live') return [];
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return snapshot.threads.filter(thread => !!thread.archivedAt === archived
    && terms.every(term => [thread.title, thread.agent, thread.project].filter(Boolean).join(' ').toLowerCase().includes(term)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastAt.localeCompare(a.lastAt) || a.id.localeCompare(b.id));
}
