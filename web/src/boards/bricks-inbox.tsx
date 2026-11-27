/** The `inbox` brick: the member's Inbox as a list, one of the desktop's fixed folders at a time.
 *
 * It is read with the Inbox's own selection (pieces/attention/inbox-query.ts: the folder's rows, every folder's
 * count, and the outcomes of the member's own actions), and its rows are chosen, ordered and worded by the Inbox's
 * own rules (pieces/inbox-view/model.ts). An item is answered in the `question` brick, which each row's chip
 * places; nothing here answers one. What the list itself does is what the desktop's list does: an unread item is
 * marked read (`inbox.read`) and an outcome is dismissed (`inbox.dismissResult`). The big form has the desktop's
 * search: what is typed goes to the Inbox's own read as its `search`, as the desktop sends it. */
import { useMemo, useRef, useState } from 'react';
import { memberOperation } from '../data/operation';
import { inboxPageSize, inboxSelection, retainedInboxItem, useInboxItemWords, useInboxSelection } from '../pieces/attention/inbox-query';
import { useDeadline } from '../pieces/comms/use-deadline';
import { currentNotices, errorsFolder, folderWords, from, noticeFolder, rows, stateWord, volumeWords, when, type InboxItem } from '../pieces/inbox-view/model';
import { Chip, Loading, Unavailable, useOwnFlag, words, type Act, type Params, type Raise } from './brick-kit';
import type { Form } from './layout';

const folders: readonly (readonly [string, string])[] = [...folderWords, errorsFolder];
const few = 4;

export function Inbox({ params, form, act, raise }: { params: Params; form: Form; act: Act; raise: Raise }) {
  const folder = folders.some(([id]) => id === params.folder) ? words(params.folder) : folderWords[0][0];
  const [offset, setOffset] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  // What the member typed to search for: this page's state, sent to the Inbox's read and never to the board.
  const [typed, setTyped] = useState('');
  const lock = useRef(false);
  const page = form === 'primary' ? offset : 0, search = form === 'primary' ? typed : '';
  const reading = useInboxSelection(useMemo(() => inboxSelection(folder, search, page), [folder, search, page]));
  const data = reading.status === 'live' ? reading.data : undefined;
  const stored = data?.items.slice(0, inboxPageSize) ?? [];
  const now = useDeadline(stored.flatMap((row) => [row.bodyKeepUntil, row.answerKeepUntil]));
  const plain = useInboxItemWords(stored);
  // A question that waits on the member arrived: the count of what needs them went up.
  useOwnFlag(data?.folders.needs, raise, (was, count) => (count > was ? 'New item' : null));
  if (reading.status === 'loading') return <Loading />;
  if (!data) return <Unavailable what="inbox" />;

  const results = { status: 'live' as const, results: data.results };
  const failed = currentNotices(results, true).length;
  const count = (id: string) => (id === errorsFolder[0] ? failed : data.folders[id as (typeof folderWords)[number][0]]);
  if (form === 'compact') return <p className="board-brief">{data.folders.needs} need you · {data.folders.alerts} alerts · {data.folders.fyi} FYI · {data.folders.answered} answered</p>;

  const items = folder === errorsFolder[0] ? [] : rows({ status: 'live', items: stored.map((row) => retainedInboxItem(row, now)) }, folder, '');
  const notices = noticeFolder(folder) ? currentNotices(results, folder === errorsFolder[0]) : [];
  const entries = [...items.map((row) => ({ at: row.at, id: row.id, row, notice: undefined })), ...notices.map((notice) => ({ at: notice.at, id: 'notice:' + notice.id, row: undefined, notice }))]
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  /** A row's line as the Inbox's list says it: its approval's plain title, its own words, or who it is from. A
   * quiet item is one line. */
  const title = (row: InboxItem) => {
    const fallback = `Item from ${from(row)}`, said = plain(row) ?? row.body?.words ?? fallback;
    return row.volume === 'dim' ? said.trimStart().split(/[\r\n]/, 1)[0] || fallback : said;
  };
  async function run(action: string, operation: string, input: Record<string, string>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await memberOperation(operation, input); act(action, {}); }
    catch { setError('Could not save. Try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  const label = folders.find(([id]) => id === folder)![1];
  const chip = (row: InboxItem) => <Chip place={{ brick: 'question', params: { item: row.id } }}>{title(row)}</Chip>;

  if (form === 'side') return (
    <>
      <p className="board-lead">{label}: {count(folder)}</p>
      {entries.slice(0, few).map(({ id, row, notice }) => (
        <div className="board-line" key={id}>
          {row ? <>{chip(row)}<span className="text-muted-foreground">{from(row)} · {stateWord(row)}</span></> : <span>{notice.text}</span>}
        </div>
      ))}
      {entries.length > few && <p className="board-line text-muted-foreground">and {Math.max(count(folder), entries.length) - few} more</p>}
      {!entries.length && <p className="text-muted-foreground">No items here.</p>}
    </>
  );
  const hasNext = data.items.length > inboxPageSize;
  return (
    <>
      <p className="board-lead">{label}: {count(folder)}</p>
      <p className="board-line text-muted-foreground">{folders.map(([id, name]) => <span key={id}>{name} {count(id)}</span>)}</p>
      {folder !== errorsFolder[0] && (
        <div className="board-line">
          <input type="search" className="board-input" aria-label="Search asks" placeholder="Search asks" value={typed} onChange={(e) => { setTyped(e.target.value); setOffset(0); }} />
          {reading.settling && <span role="status" className="text-muted-foreground">Searching…</span>}
        </div>
      )}
      {entries.length ? (
        <ol className="board-notes">
          {entries.map(({ id, row, notice }) => row ? (
            <li key={id}>
              <div className="board-line">
                {chip(row)}
                <span className="board-state">{stateWord(row)}</span>
                {row.agent ? <Chip place={{ brick: 'agent', params: { agent: row.agent } }}>{row.agent}</Chip> : <span>{from(row)}</span>}
                <span className="text-muted-foreground">{when(row.at)} · {row.read ? 'Read' : 'Unread'}{row.volume === 'dim' ? ' · ' + volumeWords.dim : ''}</span>
                {!row.read && <button type="button" className="board-action" disabled={busy} onClick={() => void run('read', 'inbox.read', { item: row.id })}>Mark read</button>}
              </div>
              {row.volume !== 'dim' && row.body?.why && <p className="text-muted-foreground">{row.body.why}</p>}
            </li>
          ) : (
            <li key={id}>
              <div className="board-line" role="status">
                <span>{notice.text}</span>
                <span className="board-state">{notice.ok ? 'Saved' : 'Error'}</span>
                <span className="text-muted-foreground">{when(notice.at)}</span>
                <button type="button" className="board-action" disabled={busy} onClick={() => void run('dismissResult', 'inbox.dismissResult', { id: notice.id })}>Dismiss</button>
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="text-muted-foreground">{search.trim() ? `Nothing matches “${search.trim()}”.` : 'No items here.'}</p>}
      {folder !== errorsFolder[0] && (offset > 0 || hasNext) && (
        <div className="board-line" role="group" aria-label="Inbox pages">
          <button type="button" className="board-action" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - inboxPageSize))}>Newer</button>
          <button type="button" className="board-action" disabled={!hasNext} onClick={() => setOffset((value) => value + inboxPageSize)}>Older</button>
        </div>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </>
  );
}
