/** The `knowledge` brick: the shared knowledge pages as Knowledge lists them (memory/queries.ts, memoryKnowledge;
 * pieces/knowledge/model.ts for which pages a list holds and in what order), each a chip that places its page.
 * Big, it has Knowledge's search and its "Add a fact". What the member types in the search box is state of this
 * drawn brick: it is sent to loom's own search (memoryKnowledgeSearch), it is never a parameter and the board never
 * holds it. A new page's words go to mind.knowledgeAdd and nowhere else. */
import { useRef, useState, type FormEvent } from 'react';
import { knowledgePageRef, knowledgeTopicRef } from '../../../src/core/boards/refs';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { memoryQueries } from '../memory/queries';
import { useMemoryQuery } from '../memory/query';
import { freshWord, shownPages, type PageRow } from '../pieces/knowledge/model';
import { Action, Actions, Chip, Few, Lead, Loading, More, Note, Problem, Row, Rows, Section, State, Time, Unavailable, count, freshTone, pageChip, words, type Act, type Params } from './brick-kit';
import type { Form } from './layout';

type Match = { slug: string; title: string; domain: string; updated: string; verified_at: string | null };
const search = 'query BrickKnowledgeSearch($query:String!,$domain:String,$first:Int){rows:memoryKnowledgeSearch(query:$query,domain:$domain,first:$first){slug title domain updated verified_at}}';
const blank = { title: '', domain: '', body: '', source: '' };
const label = { title: 'Title', domain: 'Topic', body: 'What it says', source: 'Where it came from' } as const;
const listWord: Record<string, string> = { all: 'All pages', recent: 'Recently verified', due: 'Due a check' };

function AddPage({ act, topic }: { act: Act; topic: string }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState({ ...blank, domain: topic });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [added, setAdded] = useState('');
  const lock = useRef(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (lock.current || !draft.title.trim() || !draft.domain.trim() || !draft.body.trim()) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const made = await memberOperation<{ slug: string }>('mind.knowledgeAdd', draft);
      act('add', {});
      setAdded(made?.slug ?? ''); setDraft({ ...blank, domain: topic }); setOpen(false);
    } catch { setError('That did not save. A page needs a title no other page has, and a source that is a link or empty.'); }
    finally { lock.current = false; setBusy(false); }
  };
  if (!open) return (
    <Actions>
      <Action onClick={() => { setAdded(''); setOpen(true); }}>Add a fact</Action>
      {added && <span role="status" className="board-note">Added to Knowledge {pageChip(added, 'Open fact')}</span>}
    </Actions>
  );
  return (
    <form className="board-form" aria-label="Add a fact" onSubmit={(e) => void save(e)}>
      <Note>Every fact says where it came from. Without a link, it stays provisional.</Note>
      {(['title', 'domain', 'body', 'source'] as const).map((field) => (
        <label key={field} className="board-field"><span>{label[field]}</span>
          {field === 'body'
            ? <textarea className="board-input" rows={3} required value={draft.body} disabled={busy} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            : <input className="board-input" type={field === 'source' ? 'url' : 'text'} required={field !== 'source'} maxLength={field === 'source' ? 4000 : 200} value={draft[field]} disabled={busy}
                onChange={(e) => setDraft({ ...draft, [field]: e.target.value })} />}
        </label>
      ))}
      <Actions>
        <Action submit kind="primary" disabled={busy || !draft.title.trim() || !draft.domain.trim() || !draft.body.trim()}>Add</Action>
        <Action kind="quiet" disabled={busy} onClick={() => setOpen(false)}>Cancel</Action>
      </Actions>
      <Problem>{error}</Problem>
    </form>
  );
}

export function Knowledge({ params, form, act }: { params: Params; form: Form; act: Act }) {
  const show = words(params.show) || 'all', topic = words(params.domain);
  const index = useMemoryQuery(memoryQueries.knowledge());
  const access = useMemoryQuery(form === 'primary' ? memoryQueries.knowledgeAccess() : undefined);
  const [typed, setTyped] = useState(''), [asked, setAsked] = useState('');
  const found = useDataQuery<{ rows: Match[] | null }>(search, { query: asked, domain: topic || null, first: 30 }, { keep: true, pause: !asked });
  if (index.status === 'loading') return <Loading />;
  if (index.status !== 'live' || !index.value) return <Unavailable what="knowledge" />;
  const every = index.value.pages.map((p): PageRow => ({ ...p, id: p.slug }));
  const within = topic ? every.filter((p) => p.domain === topic || p.domain.startsWith(topic + '/')) : every;
  const rows = shownPages(within, show, '');
  const due = within.filter((p) => p.fresh === 'due').length;
  const pages = count(rows.length, 'page');
  if (form === 'compact') return <p className="board-brief">{pages} · {due} due a check</p>;
  const big = form === 'primary';
  const line = (p: { slug: string; title: string; domain: string; updated: string; verified_at?: string | null }, fresh?: PageRow['fresh']) => (
    <Row key={p.slug} place={knowledgePageRef.test(p.slug) ? { brick: 'knowledge-page', params: { page: p.slug } } : undefined} title={p.title}
      meta={!big ? undefined : <>{p.domain} · {p.verified_at ? <>verified <Time at={p.verified_at} /></> : <>written <Time at={p.updated} /></>}</>}
      end={fresh && <State tone={freshTone[fresh]}>{freshWord[fresh]}</State>} />
  );
  const cap = big ? 40 : 3;
  const topics = [...new Set(within.flatMap((p) => [p.domain.split('/')[0], p.domain]))].filter((t) => t !== topic).sort();
  const submit = (e: FormEvent) => { e.preventDefault(); setAsked(typed.trim().split(/\s+/).filter(Boolean).slice(0, 20).join(' ')); };
  return (
    <>
      <Lead>{pages}</Lead>
      <div className="board-meta">
        <span>{listWord[show] ?? show}</span>
        {show !== 'due' && due > 0 && <Chip place={{ brick: 'knowledge', params: { show: 'due', ...(topic ? { domain: topic } : {}) } }}>{due} due a check</Chip>}
        {show === 'due' && <span>oldest check first</span>}
      </div>
      {big && (
        <form className="board-search" role="search" onSubmit={submit}>
          <input className="board-input" type="search" aria-label="Search knowledge" placeholder="Search knowledge…" maxLength={400} value={typed} onChange={(e) => { setTyped(e.target.value); if (!e.target.value.trim()) setAsked(''); }} />
          <Action submit disabled={!typed.trim()}>Search</Action>
          {asked && <Action kind="quiet" onClick={() => { setTyped(''); setAsked(''); }}>Show the list</Action>}
        </form>
      )}
      {asked ? (
        found.status === 'loading' ? <Loading />
          : found.status !== 'live' || !found.data?.rows ? <Note>Search is unavailable.</Note>
          : found.data.rows.length ? <Rows>{found.data.rows.map((m) => line(m, every.find((p) => p.slug === m.slug)?.fresh))}</Rows>
          : <Note>Nothing matches. Every word must be in a page's title, words or topic.</Note>
      ) : (
        <>
          {rows.length > 0 && <Few of={rows} first={cap} fit={!big}>{(shown, hidden) => <><Rows beside>{shown.map((p) => line(p, p.fresh))}</Rows><More n={hidden} /></>}</Few>}
          {!rows.length && <Note>{every.length ? 'No pages here' : 'No knowledge yet'}</Note>}
        </>
      )}
      {big && topics.length > 0 && (
        <Section title="Topics">
          <div className="board-meta">{topics.map((t) => knowledgeTopicRef.test(t)
            ? <Chip key={t} place={{ brick: 'knowledge', params: { show: 'all', domain: t } }}>{t}</Chip> : <span key={t}>{t}</span>)}</div>
        </Section>
      )}
      {big && access.status === 'live' && access.value?.canAdd && <AddPage act={act} topic={topic} />}
    </>
  );
}
