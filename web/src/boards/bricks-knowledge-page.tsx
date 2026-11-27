/** The `knowledge-page` brick: one shared knowledge page, read with Knowledge's own selection (memory/queries.ts,
 * memoryKnowledgePage) and said in its words (pieces/knowledge/model.ts). It is checked and annotated by the
 * operations Knowledge's reader calls, with the inputs it sends: mind.knowledgeVerify and mind.knowledgeRecheck take
 * the slug, mind.knowledgeAnnotate the slug, a kind and the member's words. The board is told the kind and never the
 * words. Loom reruns the read after every committed operation, so a check shows without a reload. */
import { useRef, useState, type FormEvent } from 'react';
import { knowledgeAnnotations, knowledgeTopicRef } from '../../../src/core/boards/refs';
import { memberOperation } from '../data/operation';
import { memoryQueries, type KnowledgePage as Page } from '../memory/queries';
import { useMemoryQuery } from '../memory/query';
import { Reply } from '../pair/reply';
import { freshWord } from '../pieces/knowledge/model';
import { Action, Actions, Chip, Excerpt, Fact, Facts, Lead, Loading, Note, Problem, Row, Rows, Section, Segmented, State, Time, Unavailable, freshTone, pageChip, words, type Act, type Params } from './brick-kit';
import type { Form } from './layout';

type Kind = (typeof knowledgeAnnotations)[number];
/** Knowledge's words for each kind of annotation (pieces/knowledge/index.tsx, AnnotationForm). */
export const annotationWord: Record<Kind, string> = {
  note: 'Note', outdated: 'Out of date', intent: 'Intent', 'no-longer-owned': 'Household no longer owns this', 'in-use': 'Household uses this again',
};
const link = /\[\[([a-z0-9][\w/-]*)(?:\|([^\]]+))?\]\]/gi;
const checked = (p: Page) => (p.verified_at ? <span>verified <Time at={p.verified_at} /></span> : <span>written <Time at={p.updated} />, not verified yet</span>);
/** A page's freshness, as a tone: due is the one that waits on someone. */
const checkWord = (outcome: string) => (outcome === 'confirmed' ? 'Still true' : outcome === 'stale' ? 'Asked to check again' : outcome);
const kinds = knowledgeAnnotations.map((value) => ({ value, label: annotationWord[value] }));

export function KnowledgePage({ params, form, act }: { params: Params; form: Form; act: Act }) {
  const slug = words(params.page);
  const read = useMemoryQuery(memoryQueries.page(slug));
  const access = useMemoryQuery(form === 'compact' ? undefined : memoryQueries.knowledgeAccess());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState('');
  const [kind, setKind] = useState<Kind>('note'), [draft, setDraft] = useState('');
  const lock = useRef(false);
  if (read.status === 'loading') return <Loading />;
  const page = read.value;
  if (read.status !== 'live' || !page) return <Unavailable what="knowledge page" />;
  if (form === 'compact') return <p className="board-brief"><State tone={freshTone[page.fresh]}>{freshWord[page.fresh]}</State> {page.title}</p>;
  const may = access.status === 'live' && access.value ? access.value : undefined;
  async function run(action: 'verify' | 'recheck' | 'annotate', operation: string, input: object, detail: Record<string, string>, done: string) {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(''); setSaved('');
    try { await memberOperation(operation, input); act(action, detail); setSaved(done); return true; }
    catch { setError('That did not save.'); return false; }
    finally { lock.current = false; setBusy(false); }
  }
  const annotate = async (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim() && await run('annotate', 'mind.knowledgeAnnotate', { slug, kind, words: draft.trim() }, { kind }, 'Annotation saved')) setDraft('');
  };
  const linked = [...new Map([...page.body.matchAll(link)].map((m) => [m[1], m[2] ?? m[1]])).entries()];
  const body = page.body.replace(link, (_, to: string, label?: string) => label ?? to);
  const first = body.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3).join('\n');
  const big = form === 'primary';
  return (
    <>
      <Lead>{page.title}</Lead>
      <div className="board-meta">
        <State tone={freshTone[page.fresh]}>{freshWord[page.fresh]}</State>
        {knowledgeTopicRef.test(page.domain)
          ? <Chip place={{ brick: 'knowledge', params: { domain: page.domain } }}>{page.domain}</Chip> : <span>{page.domain}</span>}
        {checked(page)}
      </div>
      {big && (
        <Note>
          {page.checked?.outcome === 'stale' ? <>Asked to be checked again <Time at={page.checked.at} /></> : `${page.archiveCandidate ? 'Archive candidate · ' : ''}Routine check every ${page.routineCheckDays} days`}
          {page.checked?.by ? ` · Last check by ${page.checked.by}` : ''}
        </Note>
      )}
      {big ? <div className="board-knowledge-body" data-form={form}><Reply words={body} /></div>
        : <Excerpt lines={5}><div className="board-knowledge-body" data-form={form}><Reply words={first} /></div></Excerpt>}
      {may && (
        <Actions>
          <Action disabled={busy || !may.canVerify} onClick={() => void run('verify', 'mind.knowledgeVerify', { slug }, {}, 'Check saved')}>Still true</Action>
          <Action disabled={busy || !may.canRecheck} onClick={() => void run('recheck', 'mind.knowledgeRecheck', { slug }, {}, 'Check saved')}>Check again</Action>
          {saved && <span role="status" className="board-note">{saved}</span>}
        </Actions>
      )}
      <Problem>{error}</Problem>
      {big && (
        <>
          {linked.length > 0 && <Section title="Links to"><div className="board-meta">{linked.map(([to, label]) => pageChip(to, label))}</div></Section>}
          {page.checks.length > 0 && (
            <Section title="Recent checks">
              <Rows>{page.checks.map((c, i) => <Row key={i} title={checkWord(c.outcome)} meta={c.by || undefined} end={<Time at={c.at} />} />)}</Rows>
            </Section>
          )}
          {page.annotations.length > 0 && (
            <Section title="Recent annotations">
              <Rows>{page.annotations.map((a) => (
                <Row key={a.id} title={<span className="whitespace-pre-wrap">{a.words}</span>} end={<Time at={a.created} />}
                  meta={<>{a.kind} · {a.actor}{a.evidence && <span className="block whitespace-pre-wrap">Evidence: {a.evidence}</span>}</>} />
              ))}</Rows>
            </Section>
          )}
          <Section title="Sources">
            {page.sources.length ? (
              <Rows>{page.sources.map((s, i) => (
                <Row key={i} title={s.claim} end={s.kind}
                  meta={s.locator ? (s.href && /^https?:\/\//.test(s.href) ? <a href={s.href} target="_blank" rel="noreferrer">{s.locator}</a> : s.locator) : undefined} />
              ))}</Rows>
            ) : <Note>No sources recorded</Note>}
          </Section>
          <Section title="Cited by">
            {page.citedBy.length ? <div className="board-meta">{page.citedBy.map((p) => pageChip(p.slug, p.title))}</div> : <Note>No referring pages</Note>}
          </Section>
          {(page.sourcing || page.by) && (
            <Facts>
              {page.sourcing && <Fact label="Sourcing">{page.sourcing}</Fact>}
              {page.by && <Fact label="Written by">{page.by}</Fact>}
            </Facts>
          )}
          {may?.canAdd && (
            <form className="board-form" aria-label="Annotate page" onSubmit={(e) => void annotate(e)}>
              <Segmented<Kind> bare label="Annotation type" value={kind} options={kinds} onChange={setKind} disabled={busy} />
              <div className="board-knowledge-add">
                <input className="board-input" aria-label="Annotation" placeholder="Add an annotation…" maxLength={4000} value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} />
                <Action submit disabled={busy || !draft.trim()}>Save annotation</Action>
              </div>
            </form>
          )}
        </>
      )}
    </>
  );
}
