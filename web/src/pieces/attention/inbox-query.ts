import { taskSegment } from '../tasks/route';
import { useSelection } from '../../data/graphql/selection';
import type { DataQuerySnapshot } from '../../data/graphql';
import type { InboxFolders, InboxItem } from '../inbox-view/model';
import type { InboxActionResult } from '../inbox-view/outcomes';
export const inboxPageSize = 50;
const fields = `id canAnswer canSetVolume quietUntil source sourceId fromId agent project thread at state volume answers waitsOnKind waitsOnId
 bodyKeepUntil answerKeepUntil body { words why ifYes ifNo link } read refs answer answerText answeredBy answeredAt resolution`;
export const inboxQuery = `query Inbox($folder:String!,$search:String!,$agent:String,$offset:Int!,$id:String!,$hasItem:Boolean!,$onlyErrors:Boolean!){
 inboxItems(folder:$folder,search:$search,agent:$agent,limit:51,offset:$offset) @skip(if:$onlyErrors){${fields}}
 inboxItem(id:$id) @include(if:$hasItem){${fields}}
 inboxFolders { needs alerts answered fyi all agents { id count } }
 inboxActionResults(limit:20){id at ok text page readAt}
}`;
interface InboxSelection { query: string; variables: Record<string, unknown>; decode(data: Record<string, unknown>): InboxReading }
export interface InboxReading { folders: InboxFolders; items: InboxItem[]; item: InboxItem | null; results: InboxActionResult[] }
function item(value: unknown): InboxItem {
  if (!value || typeof value !== 'object') throw Error('Invalid Inbox item');
  const row = value as InboxItem;
  if (typeof row.id !== 'string' || typeof row.at !== 'string' || typeof row.read !== 'boolean' || !Array.isArray(row.refs)
    || !['waiting','taken','done','answered','resolved'].includes(row.state) || !['full','dim','mute'].includes(row.volume)
    || row.body && typeof row.body.words !== 'string') throw Error('Invalid Inbox item');
  return row;
}
export function inboxSelection(folder: string, search: string, offset: number, selected?: string): InboxSelection {
  return { query: inboxQuery, variables: { folder: folder.startsWith('agent:') || folder === 'errors' ? 'all' : folder,
    search, agent: folder.startsWith('agent:') ? folder.slice(6) : null, offset, id: selected ?? '', hasItem: !!selected, onlyErrors: folder === 'errors' },
    decode(data) {
      if (folder !== 'errors' && !Array.isArray(data.inboxItems) || !Array.isArray(data.inboxActionResults)) throw Error('Invalid Inbox selection');
      const folders = data.inboxFolders as InboxFolders;
      if (!folders || !['needs','alerts','answered','fyi','all'].every(key => Number.isInteger(folders[key as keyof Pick<InboxFolders,'needs'|'alerts'|'answered'|'fyi'|'all'>])) || !Array.isArray(folders.agents)) throw Error('Invalid Inbox folders');
      return { folders, items: ((data.inboxItems ?? []) as unknown[]).map(item), item: data.inboxItem ? item(data.inboxItem) : null,
        results: data.inboxActionResults.map(value => {
          const row = value as InboxActionResult;
          if (!row || typeof row.id !== 'string' || typeof row.text !== 'string' || typeof row.ok !== 'boolean') throw Error('Invalid action result');
          return row;
        }) };
    },
  };
}
/** Decode the selected fields over the single canonical query client. */
export function useInboxSelection(selection: InboxSelection): DataQuerySnapshot<InboxReading> {
  return useSelection(selection);
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
  if (!id) return undefined;
  if (kind === 'approval') return `/p/approvals-preview/approval/${encodeURIComponent(id)}`;
  if (kind === 'secret-request') return `/p/settings-preview/requests/${encodeURIComponent(id)}`;
  if (kind === 'task') return `/p/tasks-preview/task/${taskSegment(id)}`;
}
