/** The `pull` brick: one pull request, read from the same `changes` rows the desktop's Changes reads
 * (web/src/data/work-query.ts) and said in the same words (pieces/change-view/model.ts). It has no action: a merge
 * is answered through its approval, on the desktop. */
import { useDataQuery } from '../data/graphql';
import { checksWord, checkWord, mergeableWord, reviewWord, roleWord, stateWord, summary, waitingWord, type Change, type ChangeSnapshot } from '../pieces/change-view/model';
import { Chip, Loading, Unavailable, ticketChip, useOwnFlag, words, type Params, type Raise } from './brick-kit';
import type { Form } from './layout';

type Row = Pick<Change, 'id' | 'repository' | 'number' | 'title' | 'state' | 'draft' | 'authorLogin' | 'project' | 'agent' | 'branch' | 'baseBranch' | 'checks' | 'review' | 'mergeable' | 'waitingOn'>;
type Read = {
  changes: Row[];
  changeChecks: ChangeSnapshot['checks'][number][];
  changePeople: ChangeSnapshot['people'][number][];
  changeTasks: { change: string; task: string; taskRow: { id: string; title: string; status: string } | null }[];
};
/** The fields of the desktop's ChangesView selection, for one change. */
export const pullQuery = `query BrickPull($id:String!){
  changes(where:{id:{eq:$id}},limit:1){id repository number title state draft authorLogin project agent branch baseBranch checks review mergeable waitingOn}
  changeChecks(where:{change:{eq:$id}}){change name state}
  changePeople(where:{change:{eq:$id}}){change login role}
  changeTasks(where:{change:{eq:$id}}){change task taskRow{id title status}}
}`;

/** Open, draft, merged or closed: the stored state, with a draft said as one. */
export const pullState = (c: Pick<Change, 'state' | 'draft'>) => (c.state === 'open' && c.draft ? 'Draft' : stateWord[c.state] ?? c.state);
/** What the brick marks itself for: it was merged, it was closed, or its checks went to failing. */
export function pullFlag(was: string, now: string): string | null {
  const [state, checks] = now.split('|'), [stateBefore, checksBefore] = was.split('|');
  if (state !== stateBefore) return state === 'merged' ? 'Merged' : state === 'closed' ? 'Closed' : null;
  return checks !== checksBefore && checks === 'failing' ? 'Checks failing' : null;
}

export function Pull({ params, form, raise }: { params: Params; form: Form; raise: Raise }) {
  const id = words(params.change);
  const read = useDataQuery<Read>(pullQuery, { id }, { keep: true });
  const c = read.data?.changes[0];
  useOwnFlag(c && `${c.state}|${c.checks}`, raise, pullFlag);
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !c) return <Unavailable what="pull request" />;
  if (form === 'compact') return <p className="board-brief"><span className="board-state">{pullState(c)}</span> #{c.number} {c.title}{c.state === 'open' ? ' · ' + waitingWord(c) : ''}</p>;
  // A linked ticket is shown only when the member may read the ticket itself, as the desktop does.
  const tickets = (read.data?.changeTasks ?? []).flatMap((link) => (link.taskRow && link.taskRow.id === link.task ? [link.taskRow] : []));
  const checks = [...(read.data?.changeChecks ?? [])].sort((a, b) => a.state.localeCompare(b.state));
  const people = read.data?.changePeople ?? [];
  return (
    <>
      <p className="board-lead">{c.title}</p>
      <div className="board-line">
        <span className="board-state">{pullState(c)}</span>
        <span>#{c.number}</span>
        <Chip place={{ brick: 'repository', params: { repository: c.repository } }}>{c.repository}</Chip>
        {c.project && <Chip place={{ brick: 'project', params: { project: c.project } }}>{c.project}</Chip>}
        {c.agent && <Chip place={{ brick: 'agent', params: { agent: c.agent } }}>{c.agent}</Chip>}
      </div>
      <p className="board-line">{summary(c)}</p>
      {form === 'side' && tickets.length > 0 && <div className="board-line">{tickets.map((t) => <span key={t.id} title={t.title}>{ticketChip(t.id)}</span>)}</div>}
      {form === 'primary' && (
        <dl style={{ marginTop: '.8rem' }}>
          <div><dt>Branch</dt><dd>{c.branch} into {c.baseBranch}, opened by {c.authorLogin}</dd></div>
          <div><dt>Checks</dt><dd>{checksWord[c.checks] ?? c.checks}{checks.map((k) => <span key={k.name} className="block">{checkWord[k.state] ?? k.state}: {k.name}</span>)}</dd></div>
          <div><dt>Review</dt><dd>{reviewWord[c.review] ?? c.review}</dd></div>
          <div><dt>Can be merged</dt><dd>{mergeableWord[c.mergeable] ?? c.mergeable}</dd></div>
          {people.length > 0 && <div><dt>People on it</dt><dd>{people.map((p) => <span key={p.login + ':' + p.role} className="block">{roleWord[p.role] ?? p.role}: {p.login}</span>)}</dd></div>}
          {tickets.length > 0 && <div><dt>Tickets</dt><dd>{tickets.map((t) => <span key={t.id} className="board-line" style={{ marginTop: '.3rem' }}>{ticketChip(t.id)}<span>{t.title}</span></span>)}</dd></div>}
          {c.state === 'open' && c.waitingOn === 'you' && <div><dt>Merge</dt><dd className="text-muted-foreground">The merge is answered in Changes on the desktop.</dd></div>}
        </dl>
      )}
    </>
  );
}
