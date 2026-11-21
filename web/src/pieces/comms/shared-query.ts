import { archivedQuestionFields, type ArchivedQuestion } from './archived-questions';
import type { QuerySelection } from '../../data/graphql/selection';
import type { CommsMessage, CommsThread } from '../comms-view/model';
export const threadFields = 'id conversation venue title agent project member pinned archivedAt lastAt readSeq working stopRequested';
export const messageFields = 'thread seq kind sender at words wordsKeepUntil inboxItem verdict tool cardState delivery stepInfo { exit limit parent t0 t1 } stepDetails { detail body result items { text state } }';
export const commsQuery = `query Comms($archived:Boolean!,$search:String!,$offset:Int!){
 homeComms { member agents }
 commsFolders { threads archived }
 commsThreads(archived:$archived,search:$search,offset:$offset,limit:51){${threadFields}}
}`;
export interface CommsReading {
  home: { member: string; agents: string[] } | null;
  folders: { threads: number; archived: number }; threads: CommsThread[];
}
export interface CommsThreadReading {
  archivedQuestions: ArchivedQuestion[]; thread: CommsThread | null;
  messages: CommsMessage[]; refs: { ref: string; messageSeq: number }[];
}
export function commsSelection(archived: boolean, search: string, offset: number): QuerySelection<CommsReading> {
  return { query: commsQuery, variables: { archived, search, offset }, decode(data) {
    const home = data.homeComms as CommsReading['home'], folders = data.commsFolders as CommsReading['folders'];
    if (home && (typeof home.member !== 'string' || !Array.isArray(home.agents)) || !folders || !Number.isInteger(folders.threads) || !Number.isInteger(folders.archived)
      || !Array.isArray(data.commsThreads)) throw Error('Invalid Comms selection');
    return { home, folders, threads: data.commsThreads as CommsThread[] };
  } };
}
/** The open thread, alone: its row, a page of its messages and what they mention. Opening a thread or paging its
 * messages changes this request and nothing the list of threads reads. */
export const commsThreadQuery = `query CommsThread($id:String!,$before:Int,$earlier:Boolean!=false){
 commsArchivedQuestions(thread:$id,limit:51) @skip(if:$earlier){${archivedQuestionFields}}
 commsThread(id:$id){${threadFields}}
 commsMessages(thread:$id,beforeSeq:$before,limit:51){${messageFields}}
 commsRefs(thread:$id){ref messageSeq}
}`;
export function commsThreadSelection(id: string, before?: number): QuerySelection<CommsThreadReading> {
  return { query: commsThreadQuery, variables: { id, before: before ?? null, earlier: before !== undefined }, decode(data) {
    if (!Array.isArray(data.commsMessages) || !Array.isArray(data.commsRefs)) throw Error('Invalid Comms thread');
    return { archivedQuestions: (data.commsArchivedQuestions ?? []) as ArchivedQuestion[], thread: data.commsThread as CommsThread | null ?? null, messages: data.commsMessages as CommsMessage[], refs: data.commsRefs as CommsThreadReading['refs'] };
  } };
}
/** Withhold private wording without waiting for a live refresh at the deadline. */
export function retainedCommsMessage(row: CommsMessage, now: number): CommsMessage {
  return row.wordsKeepUntil && Date.parse(row.wordsKeepUntil) > now ? row : { ...row, words: null, stepDetails:null };
}
export function commsThreadPath(id: string) { return `/p/comms-preview/thread/${encodeURIComponent(id.replace(/^th:/,''))}`; }
