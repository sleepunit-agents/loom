import { taskPath } from '../../../../src/task-route';
import { useMemo } from 'react';
import { useSelection, type QuerySelection } from '../../data/graphql/selection';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import { approvalRequestId, type InboxAnswer, type InboxFolders, type InboxItem, type InboxActionResult } from '../inbox-view/model';
import { approvalTitle } from '../approval-view/model';
import { inboxApprovalsQuery } from '../../data/work-query';
import { memberOperation } from '../../data/operation';
export const inboxPageSize = 50;
const titlesQuery = 'query InboxProposalTitles($ids:[String!]!) { inboxProposalTitles(ids:$ids) { approval title } }';
/** The server returns names only for household proposals this viewer may read. */
export function useInboxProposalTitles(ids: string[]) {
  const reading = useDataQuery<{inboxProposalTitles: {approval:string; title:string}[]}>(titlesQuery, {ids}, {pause: !ids.length});
  const rows = reading.status === 'live' ? reading.data?.inboxProposalTitles : undefined;
  return useMemo(() => ({ready: !!rows, named: new Map(rows?.map(row => [row.approval, row.title]))}), [rows]);
}
/** An approval's item is said as its card says it now: a household change by the plain title made when it is
 * read, in place of the words stored when it was filed. Undefined for every other item, and where the card is
 * not readable: the stored words stay. The same two reads the Inbox makes for its rows. */
export function useInboxItemWords(items: readonly InboxItem[]): (row: InboxItem) => string | undefined {
  const ids = [...new Set(items.flatMap(row => approvalRequestId(row) ?? []))].sort();
  const reading = useDataQuery<{approvals?: {id:string; operation?:string|null; what:string; details:string}[]}>(inboxApprovalsQuery, {ids}, {pause: !ids.length});
  const household = (reading.status === 'live' ? reading.data?.approvals ?? [] : []).filter(card => card.operation === 'household.change');
  const {named} = useInboxProposalTitles(household.map(card => card.id).sort());
  return row => { const card = household.find(card => card.id === approvalRequestId(row)); return card ? named.get(card.id) ?? approvalTitle(card) : undefined; };
}

/** Recording an answer to an Inbox item: the one action, for the Inbox and for Home's band. */
export const answerInboxItem = (id: string, answer: InboxAnswer, words?: string) =>
  memberOperation<void>('inbox.answer', { item: id, answer, ...(words ? { words } : {}) });
const fields = `id canAnswer canSetVolume quietUntil source sourceId fromId agent project thread at state volume answers waitsOnKind waitsOnId
 bodyKeepUntil answerKeepUntil body { words why ifYes ifNo link } read refs answer answerText answeredBy answeredAt resolution`;
export const inboxQuery = `query Inbox($folder:String!,$search:String!,$agent:String,$offset:Int!,$onlyErrors:Boolean!){
 inboxItems(folder:$folder,search:$search,agent:$agent,limit:51,offset:$offset) @skip(if:$onlyErrors){${fields}}
 inboxFolders { needs alerts answered fyi all agents { id count } }
 inboxActionResults(limit:20){id at ok text page readAt}
}`;
/** The open item, alone. Opening one changes this request and nothing the list reads. */
export const inboxItemQuery = `query InboxItem($id:String!){ inboxItem(id:$id){${fields} discussionAgent} }`;
interface InboxSelection { query: string; variables: Record<string, unknown>; decode(data: Record<string, unknown>): InboxReading }
export interface InboxReading { folders: InboxFolders; items: InboxItem[]; results: InboxActionResult[] }
function item(value: unknown): InboxItem {
  if (!value || typeof value !== 'object') throw Error('Invalid Inbox item');
  const row = value as InboxItem;
  if (typeof row.id !== 'string' || typeof row.at !== 'string' || typeof row.read !== 'boolean' || !Array.isArray(row.refs)
    || !['waiting','taken','done','answered','resolved'].includes(row.state) || !['full','dim','mute'].includes(row.volume)
    || row.body && typeof row.body.words !== 'string') throw Error('Invalid Inbox item');
  return row;
}
export function inboxSelection(folder: string, search: string, offset: number): InboxSelection {
  return { query: inboxQuery, variables: { folder: folder.startsWith('agent:') || folder === 'errors' ? 'all' : folder,
    search, agent: folder.startsWith('agent:') ? folder.slice(6) : null, offset, onlyErrors: folder === 'errors' },
    decode(data) {
      if (folder !== 'errors' && !Array.isArray(data.inboxItems) || !Array.isArray(data.inboxActionResults)) throw Error('Invalid Inbox selection');
      const folders = data.inboxFolders as InboxFolders;
      if (!folders || !['needs','alerts','answered','fyi','all'].every(key => Number.isInteger(folders[key as keyof Pick<InboxFolders,'needs'|'alerts'|'answered'|'fyi'|'all'>])) || !Array.isArray(folders.agents)) throw Error('Invalid Inbox folders');
      return { folders, items: ((data.inboxItems ?? []) as unknown[]).map(item),
        results: data.inboxActionResults.map(value => {
          const row = value as InboxActionResult;
          if (!row || typeof row.id !== 'string' || typeof row.text !== 'string' || typeof row.ok !== 'boolean') throw Error('Invalid action result');
          return row;
        }) };
    },
  };
}
export function inboxItemSelection(id: string): QuerySelection<InboxItem | null> {
  return { query: inboxItemQuery, variables: { id }, decode: data => data.inboxItem ? item(data.inboxItem) : null };
}
/** Decode the selected fields over the single canonical query client. The folders, counts and rows of the
 * last folder, search or page stay on screen (marked `settling`) while the next one loads. */
export function useInboxSelection(selection: InboxSelection): DataQuerySnapshot<InboxReading> {
  return useSelection(selection, { keep: true });
}
/** The open item by id, on its own small request; nothing is open with no id. Nothing is kept between
 * items: an answer here is always for this id. */
export function useInboxItem(id?: string): DataQuerySnapshot<InboxItem | null> {
  return useSelection(useMemo(() => inboxItemSelection(id ?? ''), [id]), { pause: !id });
}
/** Private question and answer wording have separate deadlines. A missing or
 * invalid private deadline is unavailable, while plain Inbox text has none. */
export function retainedInboxItem(row: InboxItem, now: number): InboxItem {
  if (!row.thread) return row;
  const retained = (until?: string | null) => !!until && Date.parse(until) > now;
  return { ...row, body: retained(row.bodyKeepUntil) ? row.body : null,
    answerText: retained(row.answerKeepUntil) ? row.answerText : null };
}

export function inboxSourcePath(row: InboxItem): string | undefined {
  const kind = row.waitsOnKind ?? row.source, id = row.waitsOnId ?? row.sourceId;
  if (kind === 'approval') {
    const card = row.waitsOnId ?? row.refs.find(ref => ref.startsWith('a-')) ?? id;
    return card ? `/p/approvals-preview/approval/${encodeURIComponent(card)}` : undefined;
  }
  if (!id) return undefined;
  if (kind === 'secret-request') return `/p/settings-preview/requests/${encodeURIComponent(id)}`;
  if (kind === 'task') return taskPath(id);
}

/** Where a reference an item is about opens, for the two kinds this app can address: a task and an approval card. */
export function inboxRefPath(ref: string): string | undefined {
  if (/^t-\d+$/.test(ref)) return taskPath(ref);
  if (/^a-[A-Za-z0-9-]+$/.test(ref)) return `/p/approvals-preview/approval/${encodeURIComponent(ref)}`;
}
