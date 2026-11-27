/** What the boards page and its bricks read about conversations and agents: the desktop's own reads and rules
 * (Comms' thread rows and their order, the shared directory's names), with no desktop component. */
import { useMemo } from 'react';
import { useDataQuery } from '../data/graphql';
import { threadFields } from '../pieces/comms/thread-fields';
import { threadRows, type CommsThread } from '../pieces/comms-view/model';
import { useDeskAgentDirectory } from '../pieces/attention/agent-directory';
import type { FaceState } from '../face';
import type { Tone } from './brick-kit';

/** An agent's display name as Comms says it: the shared directory's, or its id with a capital. */
export function useAgentNames(): (id: string) => string {
  const directory = useDeskAgentDirectory();
  return useMemo(() => (id: string) => (directory.status === 'live' ? directory.records.find((p) => p.id === `commons:${id}` && p.slug === id)?.name : undefined)
    ?? id.slice(0, 1).toUpperCase() + id.slice(1), [directory]);
}

/** The member's own threads in one of Comms' two folders (open, or archived), as Comms lists them (its first page,
 * its order: pinned, then most recent), each with whether it holds an unread reply; and the agents the member may
 * start a conversation with. */
export const boardsThreadsQuery = `query BoardsThreads($archived:Boolean!){homeComms{member agents} commsThreads(archived:$archived,search:"",offset:0,limit:51){${threadFields} unread}}`;
type Data = { homeComms: { member: string; agents: string[] } | null; commsThreads: CommsThread[] };
export interface ThreadsReading { status: 'loading' | 'live' | 'unavailable'; agents: string[]; rows: CommsThread[]; more: boolean }
export function useThreads(archived = false): ThreadsReading {
  const read = useDataQuery<Data>(boardsThreadsQuery, { archived }, { keep: true });
  return useMemo(() => {
    if (read.status === 'loading' || read.settling) return { status: 'loading', agents: [], rows: [], more: false };
    const home = read.data?.homeComms, threads = read.data?.commsThreads;
    if (read.status !== 'live' || !home || !Array.isArray(threads)) return { status: 'unavailable', agents: [], rows: [], more: false };
    return { status: 'live', agents: home.agents, more: threads.length > 50,
      rows: threadRows({ status: 'live', member: home.member, threads: threads.slice(0, 50), agents: [] }, archived, '') };
  }, [read, archived]);
}
export const threadPath = (id: string) => '/app/t/' + encodeURIComponent(id);

/** An agent's state as a tone and as its face's expression: waiting on the member first, then working, then quiet. */
export const agentTone = (state: string | undefined, needs: number | undefined): Tone => (needs ? 'waiting' : state === 'working' ? 'working' : 'muted');
export const agentMood = (state: string | undefined, needs: number | undefined): FaceState => (needs ? 'needs-input' : state === 'working' ? 'working' : 'idle');
