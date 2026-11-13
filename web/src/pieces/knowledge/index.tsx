import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useRecords, call, type Call } from '../../data';
import { Split, List, Row, Empty, Loading, Error, Input, Button, type SplitFolder } from '../../kit';
import { prose } from '../../../../src/ui/prose';
import { date, freshWord, shownPages, type Page } from './model';
const idle = { pending: false, status: 'done' as const };
const noop = () => () => {};
function Reader({ page, open, canVerify, canRecheck, request, act }: { page: Page; open(slug: string): void; canVerify: boolean; canRecheck: boolean; request?: Call; act(verb: 'knowledgeVerify' | 'knowledgeRecheck'): void }) {
  const answer = useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => idle));
  const body = useMemo(() => prose(page.body.replace(/\[\[([a-z0-9][\w/-]*)(?:\|([^\]]+))?\]\]/gi, (_, slug: string, label?: string) => `[${label ?? slug}](https://loom.invalid/knowledge/${slug})`))
    .replaceAll('href="https://loom.invalid/knowledge/', 'data-knowledge="" href="/p/knowledge-preview/page/'), [page.body]);
  return <article className="grid gap-5 p-5">
    <header><p>{page.domain}</p><h1 className="text-2xl font-semibold">{page.title}</h1><p>{freshWord[page.fresh]} · {page.verified_at ? `verified ${date(page.verified_at)}` : `written ${date(page.updated)}, not verified yet`}</p>
      <p>{page.checked?.outcome === 'stale' ? `Asked to be checked again ${date(page.checked.at)}` : 'Pages are re-checked every 30 days'}</p>
      {page.checked?.by && <p>Last check by {page.checked.by}</p>}</header>
    <div className="loom-prose" dangerouslySetInnerHTML={{ __html: body }} onClick={event => {
      const link = (event.target as HTMLElement).closest('a[data-knowledge]');
      if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); open(link.getAttribute('href')!.split('/page/')[1]);
    }} />
    <section><h2>Sources</h2>{page.sources.length ? <dl className="grid gap-3">{page.sources.map((source,n) => <div key={n}><dt>{source.kind}</dt><dd>{source.claim}{source.locator && <> · {source.href ? <a className="underline" href={source.href} target="_blank" rel="noreferrer">{source.locator}</a> : source.locator}</>}</dd></div>)}</dl> : <p>No sources recorded</p>}</section>
    <section><h2>Cited by</h2>{page.citedBy.length ? <List label="Cited by">{page.citedBy.map(p => <Row key={p.slug} title={p.title} onClick={() => open(p.slug)} />)}</List> : <p>No referring pages</p>}</section>
    <div className="flex flex-wrap gap-2"><Button disabled={answer.pending || !canVerify} onClick={() => act('knowledgeVerify')}>Still true</Button><Button variant="outline" disabled={answer.pending || !canRecheck} onClick={() => act('knowledgeRecheck')}>Check again</Button></div>
    {answer.pending ? <Loading label={answer.status === 'offline' ? 'Waiting for connection…' : 'Saving check…'} /> : answer.result && (!answer.result.ok ? <Error title="Couldn’t save check" text={`${answer.result.code}: ${answer.result.message}`} /> : <p role="status">Check saved</p>)}
    <p>{page.sourcing && `Sourcing: ${page.sourcing}. `}{page.by && `Written by ${page.by}.`}</p>
  </article>;
}
export default function KnowledgeApp({ path: shellPath, go }: { path?: string; go?: (path: string) => void } = {}) {
  const [localPath, setLocalPath] = useState(() => typeof location === 'undefined' ? '/p/knowledge-preview' : location.pathname);
  const path = (shellPath ?? localPath).split('?')[0];
  const base = '/p/knowledge-preview';
  const encoded = path.startsWith(`${base}/page/`) ? path.slice(`${base}/page/`.length) : undefined;
  let selected: string | undefined;
  try { selected = encoded ? decodeURIComponent(encoded) : undefined; } catch { selected = undefined; }
  const navigate = (slug?: string) => {
    const next = slug ? `${base}/page/${encodeURIComponent(slug)}` : base;
    if (go) go(next); else { history.pushState(null, '', next); setLocalPath(next); }
  };
  useEffect(() => {
    if (go) return;
    const pop = () => setLocalPath(location.pathname);
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, [go]);
  const [requests, setRequests] = useState(() => new Map<string, Call>());
  const access = useRecords<{ id: string; allowed: boolean; canVerify: boolean; canRecheck: boolean }>('knowledge.access');
  const permission = access.status === 'live' ? access.records[0] : undefined;
  const feed = useRecords<Page>('knowledge');
  // A direct URL or cited-by target can lie beyond the bounded list.
  const detail = useRecords<Page>('knowledge', selected ?? '');
  const [folder, setFolder] = useState('all'), [query, setQuery] = useState('');
  const current = feed.status === 'live' && detail.status === 'live' ? detail.records.find(p => p.id === selected) : undefined;
  const shown = shownPages(feed.records, folder, query);
  const topics = new Set<string>();
  for (const page of feed.records) { topics.add(page.domain.split('/')[0]); topics.add(page.domain); }
  const folders: SplitFolder[] = [
    { id:'all',label:'All pages',count:feed.records.length },
    { id:'recent',label:'Recently verified',count:feed.records.filter(p => p.recent).length },
    { id:'due',label:'Due a check',count:feed.records.filter(p => p.fresh === 'due').length,loud:true },
    ...(topics.size ? [{ heading:'Topics' }] : []),
    ...[...topics].sort().map(topic => ({ id:`t:${topic}`,label:topic.includes('/') ? topic.slice(topic.indexOf('/')+1) : topic,sub:topic.includes('/'),count:feed.records.filter(p => p.domain === topic || p.domain.startsWith(`${topic}/`)).length })),
  ];
  const activeFolder = folders.find(f => 'id' in f && f.id === folder);
  const listTitle = activeFolder && 'label' in activeFolder ? activeFolder.label : 'Knowledge';
  const unavailable = (status: string) => <Error text={status === 'denied' ? 'You don’t have access to Knowledge.' : 'Connection lost. Knowledge will return when connected.'} />;
  if (access.status === 'loading') return <Loading label="Opening knowledge…" />;
  if (access.status !== 'live') return unavailable(access.status);
  if (!permission?.allowed) return unavailable('denied');
  return <Split className="h-full" label="Knowledge" folders={folders} folder={query.trim() ? '' : folder} onFolder={id => { setFolder(id); setQuery(''); }}
    search={<label className="grid gap-1">Search knowledge<Input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>}
    listTitle={query.trim() ? `Matching “${query.trim()}”` : listTitle} listMeta={`${shown.length} pages`}
    list={feed.status === 'loading' ? <Loading label="Opening knowledge…" /> : feed.status !== 'live' ? unavailable(feed.status) : <><List label="Knowledge pages">{shown.map(page => <Row key={page.id} title={page.title} meta={`${page.verified_at ? `verified ${date(page.verified_at)}` : `written ${date(page.updated)}`} · ${page.domain}`} status={freshWord[page.fresh]} selected={page.id === selected} onClick={() => navigate(page.slug)} />)}</List>{!shown.length && <Empty title={query.trim() ? `Nothing matches “${query.trim()}”` : feed.records.length ? 'No pages here' : 'No knowledge yet'} text={query.trim() ? 'Try another search.' : 'Facts your agents learn land here.'} />}</>}
    reader={feed.status === 'loading' ? <Loading label="Opening page…" /> : feed.status !== 'live' ? unavailable(feed.status) : detail.status === 'loading' ? <Loading label="Opening page…" /> : detail.status !== 'live' ? unavailable(detail.status) : current ? <Reader key={current.slug} page={current} open={navigate} canVerify={permission.canVerify} canRecheck={permission.canRecheck} request={requests.get(current.slug)} act={verb => {
      if (requests.get(current.slug)?.getSnapshot().pending) return;
      const request = call(`mind.${verb}`, { slug: current.slug });
      setRequests(previous => new Map(previous).set(current.slug, request));
    }} /> : selected ? <Empty title="This page is no longer available" text="It may have been archived or moved." /> : null}
    open={!!selected} onBack={() => navigate()} backLabel="Knowledge" blank={<Empty title="Open a page" text="Choose a fact to read its sources and check it." />} />;
}
