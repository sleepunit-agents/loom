import { Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { NativeSelect } from '../../kit/native-select';
import type { ReactNode } from 'react';
import type {Call} from '../../data/store';
import {memoryCall as call} from '../../memory/commands';
import {frozen} from '../../data/mutation';
import { Reader as PageReader, Title, Meta, Section, Facts, Fact, Search, Split, List, Row, Empty, Loading, Error, Input, Textarea, Button, Markdown, type SplitFolder } from '../../kit';
import {useMemoryQuery} from '../../memory/query';
import {memoryQueries} from '../../memory/queries';
import { date, freshWord, shownPages, type Page } from './model';
const idle = { pending: false, status: 'done' as const };
const noop = () => () => {};
function AnnotationForm({request, save, reset}: {request?: Call; save(kind: string, words: string): void; reset(): void}) {
  const [kind, setKind] = useState('note');
  const [words, setWords] = useState('');
  const answer = useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => idle));
  if (answer.result?.ok) return <p role="status">Annotation saved <Button onClick={() => {setWords(''); reset();}}>Add another annotation</Button></p>;
  return <form aria-label="Annotate page" onSubmit={event => {
    event.preventDefault();
    if (words.trim() && !frozen(answer)) save(kind, words.trim());
  }}>
    <fieldset className="grid gap-2" disabled={frozen(answer)}>
      <label>Annotation type <NativeSelect value={kind} onChange={event => setKind(event.target.value)}>
        <option value="note">Note</option><option value="outdated">Out of date</option><option value="intent">Intent</option>
      </NativeSelect></label>
      <label>Annotation <Textarea required maxLength={4000} value={words} onChange={event => setWords(event.target.value)} /></label>
      <Button type="submit">Save annotation</Button>
    </fieldset>
    {answer.pending && <Loading label="Saving annotation…" />}
    {answer.result && !answer.result.ok && <div><Error text={answer.result.message} />
      {answer.result.code === 'unavailable' && <Button type="button" onClick={() => request?.retry?.()}>Retry this annotation</Button>}</div>}
  </form>;
}
function Reader({ page, zone, open, canVerify, canRecheck, request, act, annotationForm }: { annotationForm?: ReactNode; page: Page; zone?: string; open(slug: string): void; canVerify: boolean; canRecheck: boolean; request?: Call; act(verb: 'knowledgeVerify' | 'knowledgeRecheck'): void }) {
  const answer = useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => idle));
  const body = useMemo(() => page.body.replace(/\[\[([a-z0-9][\w/-]*)(?:\|([^\]]+))?\]\]/gi, (_, slug: string, label?: string) => `[${label ?? slug}](https://loom.invalid/knowledge/${slug})`), [page.body]);
  return <PageReader>
    <header><Meta>{page.domain}</Meta><Title as="h1">{page.title}</Title><Meta>{freshWord[page.fresh]} · {page.verified_at ? `verified ${date(page.verified_at, zone)}` : `written ${date(page.updated, zone)}, not verified yet`}</Meta>
      <Meta>{page.checked?.outcome === 'stale' ? `Asked to be checked again ${date(page.checked.at, zone)}` : 'Pages are re-checked every 30 days'}</Meta>
      {page.checked?.by && <Meta>Last check by {page.checked.by}</Meta>}</header>
    <div className="flex flex-wrap gap-2"><Button disabled={frozen(answer) || !canVerify} onClick={() => act('knowledgeVerify')}>Still true</Button><Button variant="outline" disabled={frozen(answer) || !canRecheck} onClick={() => act('knowledgeRecheck')}>Check again</Button></div>
    {answer.pending ? <Loading label={answer.status === 'offline' ? 'Waiting for connection…' : 'Saving check…'} /> : answer.result && (!answer.result.ok ? <div><Error title="Couldn’t save check" text={`${answer.result.code}: ${answer.result.message}`} />{answer.result.code==='unavailable'&&<Button onClick={()=>request?.retry?.()}>Retry this check</Button>}</div> : <p role="status">Check saved</p>)}
    <Suspense fallback={<Loading label="Opening words…" />}><Markdown text={body} onLink={href => {
      const prefix = 'https://loom.invalid/knowledge/';
      if (!href.startsWith(prefix)) return false;
      open(href.slice(prefix.length)); return true;
    }} /></Suspense>
    {(page.checks?.length ?? 0) > 0 && <Section label="Recent checks"><ol>{page.checks.map((check, index) =>
      <li key={index}>{check.outcome === 'confirmed' ? 'Still true' : check.outcome === 'stale' ? 'Asked to check again' : check.outcome} · {date(check.at, zone)}{check.by && ` · ${check.by}`}</li>
    )}</ol></Section>}
    {!!page.annotations?.length && <Section label="Recent annotations"><ul className="grid gap-3">
      {page.annotations.map(annotation => <li key={annotation.id}>
        <Meta>{annotation.kind} · {annotation.actor} · {date(annotation.created, zone)}</Meta>
        <p className="whitespace-pre-wrap">{annotation.words}</p>
        {annotation.evidence && <p className="whitespace-pre-wrap">Evidence: {annotation.evidence}</p>}
      </li>)}
    </ul></Section>}
    {annotationForm}
    <Section label="Sources">{page.sources.length ? <dl className="grid gap-3">{page.sources.map((source,n) => <div key={n}><dt>{source.kind}</dt><dd>{source.claim}{source.locator && <> · {source.href ? <a className="underline" href={source.href} target="_blank" rel="noreferrer">{source.locator}</a> : source.locator}</>}</dd></div>)}</dl> : <p>No sources recorded</p>}</Section>
    <Section label="Cited by">{page.citedBy.length ? <List label="Cited by">{page.citedBy.map(p => <Row key={p.slug} title={p.title} onClick={() => open(p.slug)} />)}</List> : <p>No referring pages</p>}</Section>
    {(page.sourcing || page.by) && <Facts><Fact label="Sourcing">{page.sourcing}</Fact><Fact label="Written by">{page.by}</Fact></Facts>}
  </PageReader>;
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
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: '', domain: '', body: '', source: '' });
  const addRequest = requests.get('$add');
  const addAnswer = useSyncExternalStore(addRequest?.subscribe ?? noop, addRequest?.getSnapshot ?? (() => idle));
  const access = useMemoryQuery(memoryQueries.knowledgeAccess());
  const permission = access.status === 'live' ? access.value : undefined;
  const index = useMemoryQuery(memoryQueries.knowledge());
  const zone = index.value?.timezone;
  const feed = {status:index.status,records:(index.value?.pages??[]).map(page=>({...page,id:page.slug}))};
  const selectedPage = useMemoryQuery(selected?memoryQueries.page(selected):undefined);
  const detail = {status:selectedPage.status,records:selectedPage.value?[{...selectedPage.value,id:selectedPage.value.slug}]:[]};
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
  const addForm = <form aria-label="Add a fact" className="grid gap-4 p-5" onSubmit={event => {
    event.preventDefault(); if (!permission.canAdd || frozen(addAnswer) || addAnswer.result?.ok===true) return;
    const request = call('mind.knowledgeAdd', draft);
    setRequests(previous => new Map(previous).set('$add', request));
  }}><h1>Add a fact</h1><p>Every fact says where it came from. Without a link, it stays provisional.</p>
    <fieldset disabled={!permission.canAdd || frozen(addAnswer) || addAnswer.result?.ok === true} className="grid gap-3">
      {(['title','domain','body','source'] as const).map(field => <label key={field} className="grid gap-1">{{title:'Title',domain:'Topic',body:'What it says',source:'Where it came from'}[field]}
        {field === 'body' ? <Textarea required value={draft[field]} onChange={e => setDraft({...draft,[field]:e.target.value})} /> : <Input type={field === 'source' ? 'url' : 'text'} required={field !== 'source'} value={draft[field]} onChange={e => setDraft({...draft,[field]:e.target.value})} />}</label>)}
      <Button type="submit">Add</Button>
    </fieldset>
    {addAnswer.pending ? <Loading label="Saving fact…" /> : addAnswer.result && (!addAnswer.result.ok ? <div><Error text={`${addAnswer.result.code}: ${addAnswer.result.message}`} />{addAnswer.result.code==='unavailable'&&<Button type="button" disabled={!permission.canAdd} onClick={()=>addRequest?.retry?.()}>Retry this save</Button>}</div> : <p role="status">Added to Knowledge<Button type="button" onClick={() => { const result = addAnswer.result; if (result?.ok) { setAdding(false); navigate((result.value as {slug:string}).slug); } }}>Open fact</Button><Button type="button" onClick={() => { setDraft({title:'',domain:'',body:'',source:''}); setRequests(previous => { const next=new Map(previous);next.delete('$add');return next; }); }}>Add another</Button></p>)}
  </form>;
  return <Split className="h-full" label="Knowledge" folders={folders} folder={query.trim() ? '' : folder} onFolder={id => { setFolder(id); setQuery(''); }}
    search={<Search label="Search knowledge" value={query} onChange={setQuery} />}
    listAction={<Button disabled={!permission.canAdd} onClick={() => setAdding(true)}>Add a fact</Button>}
    listTitle={query.trim() ? `Matching “${query.trim()}”` : listTitle} listCount={shown.length}
    list={feed.status === 'loading' ? <Loading label="Opening knowledge…" /> : feed.status !== 'live' ? unavailable(feed.status) : <><List label="Knowledge pages">{shown.map(page => <Row key={page.id} title={page.title} meta={`${page.verified_at ? `verified ${date(page.verified_at, zone)}` : `written ${date(page.updated, zone)}`} · ${page.domain}`} status={freshWord[page.fresh]} selected={page.id === selected} onClick={() => { setAdding(false); navigate(page.slug); }} />)}</List>{!shown.length && <Empty title={query.trim() ? `Nothing matches “${query.trim()}”` : feed.records.length ? 'No pages here' : 'No knowledge yet'} text={query.trim() ? 'Try another search.' : 'Facts your agents learn land here.'} />}</>}
    reader={adding ? addForm : feed.status === 'loading' ? <Loading label="Opening page…" /> : feed.status !== 'live' ? unavailable(feed.status) : detail.status === 'loading' ? <Loading label="Opening page…" /> : detail.status !== 'live' ? unavailable(detail.status) : current ? <Reader key={current.slug} page={current} annotationForm={permission.canAdd && <AnnotationForm request={requests.get('$annotation/'+current.slug)}
      save={(kind, words) => {
        const key = '$annotation/'+current.slug;
        const previous = requests.get(key);
        if (previous && frozen(previous.getSnapshot())) return;
        const request = call('mind.knowledgeAnnotate', {slug:current.slug, kind, words});
        setRequests(previous => new Map(previous).set(key, request));
      }} reset={() => setRequests(previous => {const next = new Map(previous); next.delete('$annotation/'+current.slug); return next;})} />} zone={zone} open={navigate} canVerify={permission.canVerify} canRecheck={permission.canRecheck} request={requests.get(current.slug)} act={verb => {
      const previous=requests.get(current.slug);if(previous&&frozen(previous.getSnapshot()))return;
      const request = call(`mind.${verb}`, { slug: current.slug });
      setRequests(previous => new Map(previous).set(current.slug, request));
    }} /> : selected ? <Empty title="This page is no longer available" text="It may have been archived or moved." /> : null}
    open={!!selected || adding} onBack={() => { setAdding(false); navigate(); }} backLabel="Knowledge" blank={<Empty title="Open a page" text="Choose a fact to read its sources and check it." />} />;
}
