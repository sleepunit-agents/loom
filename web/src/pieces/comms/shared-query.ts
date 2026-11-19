import type { QuerySelection } from '../../data/graphql/selection';
import type { CommsMessage, CommsThread } from '../comms-view/model';
export const threadFields = 'id conversation venue title agent project member pinned archivedAt lastAt readSeq working stopRequested';
export const messageFields = 'thread seq kind sender at words wordsKeepUntil inboxItem verdict tool cardState delivery';
/** The list: threads, folder counts and who is asking. Comms no longer asks for the open thread here (`selected`
 * is false; see `commsThreadQuery`). Those clauses stay because server tests run this exact document with them. */
export const commsQuery = `query Comms($archived:Boolean!,$search:String!,$offset:Int!,$id:String!,$selected:Boolean!,$before:Int){
 homeComms { member agents }
 commsFolders { threads archived }
 commsThreads(archived:$archived,search:$search,offset:$offset,limit:51){${threadFields}}
 commsThread(id:$id) @include(if:$selected){${threadFields}}
 commsMessages(thread:$id,beforeSeq:$before,limit:51) @include(if:$selected){${messageFields}}
 commsRefs(thread:$id) @include(if:$selected){ref messageSeq}
}`;
export interface CommsReading {
  home: { member: string; agents: string[] } | null;
  folders: { threads: number; archived: number }; threads: CommsThread[]; thread: CommsThread | null;
  messages: CommsMessage[]; refs: { ref: string; messageSeq: number }[];
}
export function commsSelection(archived: boolean, search: string, offset: number, id?: string, before?: number): QuerySelection<CommsReading> {
  return { query: commsQuery, variables: { archived, search, offset, id: id ?? '', selected: !!id, before: before ?? null }, decode(data) {
    const home = data.homeComms as CommsReading['home'], folders = data.commsFolders as CommsReading['folders'];
    if (home && (typeof home.member !== 'string' || !Array.isArray(home.agents)) || !folders || !Number.isInteger(folders.threads) || !Number.isInteger(folders.archived)
      || !Array.isArray(data.commsThreads) || id && (!Array.isArray(data.commsMessages) || !Array.isArray(data.commsRefs))) throw Error('Invalid Comms selection');
    return { home, folders, threads: data.commsThreads as CommsThread[], thread: data.commsThread as CommsThread | null ?? null,
      messages: data.commsMessages as CommsMessage[] ?? [], refs: data.commsRefs as CommsReading['refs'] ?? [] };
  } };
}
/** The open thread, alone: its row, a page of its messages and what they mention. Opening a thread or paging its
 * messages changes this request and nothing the list of threads reads. */
export const commsThreadQuery = `query CommsThread($id:String!,$before:Int){
 commsThread(id:$id){${threadFields}}
 commsMessages(thread:$id,beforeSeq:$before,limit:51){${messageFields}}
 commsRefs(thread:$id){ref messageSeq}
}`;
export type CommsThreadReading = Pick<CommsReading, 'thread' | 'messages' | 'refs'>;
export function commsThreadSelection(id: string, before?: number): QuerySelection<CommsThreadReading> {
  return { query: commsThreadQuery, variables: { id, before: before ?? null }, decode(data) {
    if (!Array.isArray(data.commsMessages) || !Array.isArray(data.commsRefs)) throw Error('Invalid Comms thread');
    return { thread: data.commsThread as CommsThread | null ?? null, messages: data.commsMessages as CommsMessage[], refs: data.commsRefs as CommsReading['refs'] };
  } };
}
/** Withhold private wording without waiting for a live refresh at the deadline. */
export function retainedCommsMessage(row: CommsMessage, now: number): CommsMessage {
  return row.wordsKeepUntil && Date.parse(row.wordsKeepUntil) > now ? row : { ...row, words: null };
}
export function commsThreadPath(id: string) { return `/p/comms-preview/thread/${encodeURIComponent(id.replace(/^th:/,''))}`; }
