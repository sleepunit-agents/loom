/** The `knowledge-page` brick: one shared knowledge page, read with Knowledge's own selection (memory/queries.ts,
 * memoryKnowledgePage) and said in its words (pieces/knowledge/model.ts). It is checked and annotated by the
 * operations Knowledge's reader calls, with the inputs it sends: mind.knowledgeVerify and mind.knowledgeRecheck take
 * the slug, mind.knowledgeAnnotate the slug, a kind and the member's words. The board is told the kind and never the
 * words. Loom reruns the read after every committed operation, so a check shows without a reload. */
import { useRef, useState, type FormEvent } from 'react';
import { knowledgeAnnotations, knowledgePageRef, knowledgeTopicRef } from '../../../src/core/boards/refs';
import { memberOperation } from '../data/operation';
import { memoryQueries, type KnowledgePage as Page } from '../memory/queries';
import { useMemoryQuery } from '../memory/query';
import { Reply } from '../pair/reply';
import { date, freshWord } from '../pieces/knowledge/model';
import { Chip, Loading, Unavailable, words, type Act, type Params } from './bricks';
import type { Form } from './layout';

type Kind = (typeof knowledgeAnnotations)[number];
/** Knowledge's words for each kind of annotation (pieces/knowledge/index.tsx, AnnotationForm). */
export const annotationWord: Record<Kind, string> = {
  note: 'Note', outdated: 'Out of date', intent: 'Intent', 'no-longer-owned': 'Household no longer owns this', 'in-use': 'Household uses this again',
};
const link = /\[\[([a-z0-9][\w/-]*)(?:\|([^\]]+))?\]\]/gi;
/** A chip for another page, or its words alone when its slug is not one a board can hold. */
export const pageChip = (slug: string, label: string) => knowledgePageRef.test(slug)
  ? <Chip key={slug} place={{ brick: 'knowledge-page', params: { page: slug } }}>{label}</Chip> : <span key={slug}>{label}</span>;
const checked = (p: Page) => (p.verified_at ? `verified ${date(p.verified_at)}` : `written ${date(p.updated)}, not verified yet`);

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
  if (form === 'compact') return <p className="board-brief"><span className="board-state">{freshWord[page.fresh]}</span> {page.title}</p>;
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
  return (
    <>
      <p className="board-lead">{page.title}</p>
      <div className="board-line">
        <span className="board-state" data-due={page.fresh === 'due'}>{freshWord[page.fresh]}</span>
        {knowledgeTopicRef.test(page.domain)
          ? <Chip place={{ brick: 'knowledge', params: { domain: page.domain } }}>{page.domain}</Chip> : <span>{page.domain}</span>}
        <span className="text-muted-foreground">{checked(page)}</span>
      </div>
      {form === 'primary' && (
        <p className="board-line text-muted-foreground">
          {page.checked?.outcome === 'stale' ? `Asked to be checked again ${date(page.checked.at)}` : `${page.archiveCandidate ? 'Archive candidate · ' : ''}Routine check every ${page.routineCheckDays} days`}
          {page.checked?.by ? ` · Last check by ${page.checked.by}` : ''}
        </p>
      )}
      {may && (
        <div className="board-line">
          <button type="button" className="board-action" disabled={busy || !may.canVerify} onClick={() => void run('verify', 'mind.knowledgeVerify', { slug }, {}, 'Check saved')}>Still true</button>
          <button type="button" className="board-action" disabled={busy || !may.canRecheck} onClick={() => void run('recheck', 'mind.knowledgeRecheck', { slug }, {}, 'Check saved')}>Check again</button>
        </div>
      )}
      {saved && <p role="status" className="text-muted-foreground">{saved}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {form === 'side' ? <Reply words={first} /> : (
        <>
          <Reply words={body} />
          <dl style={{ marginTop: '.8rem' }}>
            {linked.length > 0 && <div><dt>Links to</dt><dd className="board-line">{linked.map(([to, label]) => pageChip(to, label))}</dd></div>}
            {page.checks.length > 0 && <div><dt>Recent checks</dt><dd>{page.checks.map((c, i) => (
              <span key={i} className="block">{c.outcome === 'confirmed' ? 'Still true' : c.outcome === 'stale' ? 'Asked to check again' : c.outcome} · {date(c.at)}{c.by ? ` · ${c.by}` : ''}</span>))}</dd></div>}
            {page.annotations.length > 0 && <div><dt>Recent annotations</dt><dd>{page.annotations.map((a) => (
              <span key={a.id} className="block"><small>{a.kind} · {a.actor} · {date(a.created)}</small><span className="block whitespace-pre-wrap">{a.words}</span>
                {a.evidence && <span className="block whitespace-pre-wrap">Evidence: {a.evidence}</span>}</span>))}</dd></div>}
            <div><dt>Sources</dt><dd>{page.sources.length ? page.sources.map((s, i) => (
              <span key={i} className="block">{s.kind}: {s.claim}{s.locator && <> · {s.href && /^https?:\/\//.test(s.href) ? <a className="underline" href={s.href} target="_blank" rel="noreferrer">{s.locator}</a> : s.locator}</>}</span>))
              : <span className="text-muted-foreground">No sources recorded</span>}</dd></div>
            <div><dt>Cited by</dt><dd className="board-line">{page.citedBy.length ? page.citedBy.map((p) => pageChip(p.slug, p.title)) : <span className="text-muted-foreground">No referring pages</span>}</dd></div>
            {page.sourcing && <div><dt>Sourcing</dt><dd>{page.sourcing}</dd></div>}
            {page.by && <div><dt>Written by</dt><dd>{page.by}</dd></div>}
          </dl>
          {may?.canAdd && (
            <form aria-label="Annotate page" onSubmit={(e) => void annotate(e)}>
              <div className="board-line" role="group" aria-label="Annotation type">
                {knowledgeAnnotations.map((k) => <button key={k} type="button" className="board-action" aria-pressed={kind === k} disabled={busy} onClick={() => setKind(k)}>{annotationWord[k]}</button>)}
              </div>
              <div className="board-line">
                <input className="board-input" aria-label="Annotation" placeholder="Add an annotation…" maxLength={4000} value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} />
                <button type="submit" className="board-action" disabled={busy || !draft.trim()}>Save annotation</button>
              </div>
            </form>
          )}
        </>
      )}
    </>
  );
}
