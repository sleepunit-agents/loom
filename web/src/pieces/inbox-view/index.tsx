import { InboxNotice, currentNotices, type InboxResultsSnapshot } from './outcomes';
import { AnswerSection } from './answer';
export { InboxActionNotices } from './outcomes';
export { AnswerSection } from './answer';
export type { InboxActionResult, InboxResultsSnapshot } from './outcomes';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Split, Row, Empty, Error, Loading, LinkButton, Search, Pager, Reader, Meta, Title, Facts, Fact, Section, Body, Foot, Chips, Chip, type SplitFolder } from '../../kit';
import { managed, rows, from, stateWord, answerWord, sourceLabel, volumeWords, volumeNote, when, type InboxActions, type InboxAnswer, type InboxItem, type InboxSnapshot } from './model';
export type { InboxActions, InboxItem, InboxSnapshot } from './model';
const safeLink = (value?: string | null) => value && (/^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value)) ? value : undefined;

/** The same reader can appear inline or in the Inbox tile. Mutations belong to
 * the authenticated operation client supplied by composition. */
function QuestionReader({ item, actions, inline, sourceCard }: { item: InboxItem; actions?: InboxActions; inline?: boolean; sourceCard?: ReactNode }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const lock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setError(false); }, [item.id, item.body?.words]);
  const canRead = !!actions?.read;
  useEffect(() => {
    if (!item.read && actions?.read) void actions.read(item.id).catch(() => { if (mounted.current) setError(true); });
  }, [item.id, canRead]);
  const answer = async (verdict: InboxAnswer, words?: string) => {
    if (lock.current || item.state !== 'waiting' || !item.answers || !item.body || managed(item) || !actions?.answer) return;
    if (verdict === 'words' && !words?.trim()) return;
    lock.current = true; setBusy(true); setError(false);
    try { await actions.answer(item.id, verdict, words?.trim()); }
    catch { if (mounted.current) setError(true); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const volume = async (value: InboxItem['volume']) => {
    if (lock.current || value === item.volume || !item.canSetVolume || !actions?.volume) return;
    lock.current = true; setBusy(true); setError(false);
    try { await actions.volume(item.id, value); }
    catch { if (mounted.current) setError(true); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const waiting = item.state === 'waiting', link = safeLink(item.body?.link);
  return <Reader aria-label="Inbox item" data-inline={inline || undefined}>
    <Meta>{`${from(item)} · ${stateWord(item)}`}</Meta>
    <Title>{item.body?.words ?? 'Message words are unavailable'}</Title>
    <Meta><time dateTime={item.at}>{when(item.at)}</time>{item.project && ` · ${item.project}`}</Meta>
    {(item.body?.why || item.body?.ifYes || item.body?.ifNo || item.refs.length > 0) && <Facts>
      <Fact label="Why">{item.body?.why}</Fact>
      <Fact label="If yes">{item.body?.ifYes}</Fact>
      <Fact label="If no">{item.body?.ifNo}</Fact>
      {item.refs.length > 0 && <Fact label="About"><Chips label="About">{item.refs.map(ref => <Chip key={ref} onClick={actions?.openRef?.(ref)} label={`Open ${ref}`}>{ref}</Chip>)}</Chips></Fact>}
    </Facts>}
    {link && <a className="loom-kit-link" href={link} target="_blank" rel="noreferrer">Open linked page</a>}
    {managed(item) && actions?.openSource && <LinkButton onClick={() => actions.openSource!(item)}>{sourceLabel(item)}</LinkButton>}
    {waiting && item.answers && item.body && !managed(item) && actions?.answer && <AnswerSection key={`${item.id}:${item.body.words}`} answers={item.answers} busy={busy}
      yes={inline ? 'Allow' : 'Yes'} no={inline ? 'Deny' : 'No'} settle onAnswer={(verdict, words) => void answer(verdict, words)} />}
    {sourceCard}
    {item.answer && <Section label="Answer">
      <Meta>{[answerWord(item.answer), item.answeredBy, item.answeredAt && when(item.answeredAt)].filter(Boolean).join(' · ')}</Meta>
      {item.answerText && <Body>{item.answerText}</Body>}
    </Section>}
    {item.resolution && <Section label="Settled"><Body>{item.resolution}</Body></Section>}
    {error && <Error text="Could not save. Try again." />}
    {item.canSetVolume && actions?.volume && <Foot>
      <label>Notify <select aria-label="Notify" value={item.volume} disabled={busy} onChange={event => void volume(event.target.value as InboxItem['volume'])}>
        {(['full', 'dim', 'mute'] as const).map(value => <option key={value} value={value}>{volumeWords[value]}</option>)}
      </select></label>
      {item.volume !== 'full' && <span>{volumeNote[item.volume]}{item.quietUntil && <> · back to normal <time dateTime={item.quietUntil}>{when(item.quietUntil)}</time></>}</span>}
    </Foot>}
  </Reader>;
}

export function InboxQuestionCard({ id, snapshot, actions, inline, sourceCard }: { id: string; snapshot: InboxSnapshot; actions?: InboxActions; inline?: boolean; sourceCard?: ReactNode }) {
  const item = snapshot.status === 'live' ? snapshot.items.find(row => row.id === id) : undefined;
  return item ? <QuestionReader key={item.id} item={item} actions={actions} inline={inline} sourceCard={sourceCard} /> : <Empty title="Item is unavailable" />;
}

export function InboxView({ snapshot, selected, select, detail, actions, results, dismissResult, navigation, sourceCard }: {
  sourceCard?(item: InboxItem): ReactNode;
  navigation?: { folder: string; query: string; offset: number; hasNext: boolean; onFolder(id: string): void; onQuery(value: string): void; previous(): void; next(): void };
  results?: InboxResultsSnapshot; dismissResult?(id: string): Promise<void>;
  snapshot: InboxSnapshot; selected?: string; select(id?: string): void;
  detail?: { status: InboxSnapshot['status']; item: InboxItem | null }; actions?: InboxActions;
}) {
  const [localFolder, setFolder] = useState('needs'), [localQuery, setQuery] = useState('');
  const folder = navigation?.folder ?? localFolder, query = navigation?.query ?? localQuery;
  const display = selected && detail && detail.status !== 'live'
    ? { ...snapshot, items: snapshot.items.filter(row => row.id !== selected) } : snapshot;
  const shown = folder === 'errors' ? [] : rows(display, folder, navigation ? '' : query);
  const live = snapshot.status === 'live';
  // Outcomes of this person's own actions sit in the list as quiet rows, in time order with the items around them.
  const notices = live && (folder === 'fyi' || folder === 'errors' || folder === 'all') ? currentNotices(results, folder === 'errors') : [];
  const entries = [...shown.map(row => ({ at: row.at, id: row.id, row, notice: undefined })), ...notices.map(notice => ({ at: notice.at, id: `notice:${notice.id}`, row: undefined, notice }))]
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const item = live ? (detail ? detail.status === 'live' && detail.item?.id === selected ? detail.item : undefined : snapshot.items.find(row => row.id === selected)) : undefined;
  const folders: SplitFolder[] = [
    ...[['needs', 'Needs you'], ['alerts', 'Alerts'], ['answered', 'Answered'], ['fyi', 'FYI'], ['all', 'All items']].map(([id, label]) => ({ id, label, count: live && snapshot.folders ? snapshot.folders[id as 'needs' | 'alerts' | 'answered' | 'fyi' | 'all'] : rows(display, id, '').length })),
    { id: 'errors', label: 'Errors', count: currentNotices(live ? results : undefined, true).length },
    { heading: 'By agent' }, ...(live && snapshot.folders ? snapshot.folders.agents : [...new Set(live ? display.items.flatMap(row => row.agent ? [row.agent] : []) : [])].sort().map(id => ({ id, count: rows(display, `agent:${id}`, '').length })))
      .map(agent => ({ id: `agent:${agent.id}`, label: agent.id, count: agent.count })),
  ];
  const current = folders.find((entry): entry is Extract<SplitFolder, { id: string }> => 'id' in entry && entry.id === folder);
  return <Split label="Inbox" folders={folders} folder={folder} onFolder={id => navigation ? navigation.onFolder(id) : setFolder(id)}
    listTitle={current?.label ?? 'Inbox'} listCount={live ? current?.count : undefined}
    listTop={navigation && folder !== 'errors' && <Pager label="Inbox pages" disabled={!live} hasPrevious={navigation.offset > 0} hasNext={navigation.hasNext} previous={navigation.previous} next={navigation.next} />}
    search={<Search label="Search asks" value={live ? query : ''} disabled={!live} onChange={value => navigation ? navigation.onQuery(value) : setQuery(value)} />}
    list={!live ? snapshot.status === 'loading' ? <Loading /> : <Empty title="Inbox is unavailable" /> : entries.length ? entries.map(({ id, row, notice }) => notice ? <InboxNotice key={id} result={notice} dismiss={dismissResult} />
      : <Row key={id} title={row.body?.words ?? `Item from ${from(row)}`} className={row.volume === 'dim' ? '[&_.loom-kit-title]:line-clamp-1' : undefined} meta={row.volume === 'dim' ? undefined : row.body?.why ?? undefined}
        status={row.volume === 'dim' ? undefined : `${from(row)} · ${stateWord(row)} · ${row.read ? 'Read' : 'Unread'}`} selected={row.id === selected} onClick={() => select(row.id)} />) : <Empty title="No items here" />}
    reader={item ? <InboxQuestionCard key={item.id} id={item.id} snapshot={{ status: 'live', items: [item] }} actions={actions} sourceCard={sourceCard?.(item)} /> : selected && live && detail?.status === 'loading' ? <Loading /> : null}
    open={!!selected} onBack={() => select(undefined)} backLabel="Back to Inbox" blank={<Empty title="Choose an item" />} />;
}
