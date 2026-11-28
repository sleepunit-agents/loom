/** The `pull` brick: one pull request, read from the same `changes` rows the desktop's Changes reads
 * (web/src/data/work-query.ts) and said in the same words (pieces/change-view/model.ts), with
 * a link to its page on GitHub and, big, the files it touches (`change_files`, kept from the same read of GitHub). It has no action: a merge
 * is answered through its approval, on the desktop. */
import { useDataQuery } from '../data/graphql';
import { checksWord, checkWord, mergeableWord, reviewWord, roleWord, stateWord, summary, waitingWord, type Change, type ChangeSnapshot } from '../pieces/change-view/model';
import { Chip, Fact, Facts, Lead, Loading, Note, Row, Rows, Section, State, Unavailable, ticketChip, useOwnFlag, words, type Params, type Raise, type Tone } from './brick-kit';
import type { Form } from './layout';

type Row = Pick<Change, 'id' | 'repository' | 'number' | 'url' | 'title' | 'state' | 'draft' | 'authorLogin' | 'project' | 'agent' | 'branch' | 'baseBranch' | 'checks' | 'review' | 'mergeable' | 'waitingOn'>;
type Read = {
  changes: Row[];
  changeChecks: ChangeSnapshot['checks'][number][];
  changePeople: ChangeSnapshot['people'][number][];
  changeFiles: { change: string; path: string; additions: number; deletions: number }[];
  changeTasks: { change: string; task: string; taskRow: { id: string; title: string; status: string } | null }[];
};
/** The fields of the desktop's ChangesView selection, for one change. */
export const pullQuery = `query BrickPull($id:String!){
  changes(where:{id:{eq:$id}},limit:1){id repository number url title state draft authorLogin project agent branch baseBranch checks review mergeable waitingOn}
  changeChecks(where:{change:{eq:$id}}){change name state}
  changePeople(where:{change:{eq:$id}}){change login role}
  changeTasks(where:{change:{eq:$id}}){change task taskRow{id title status}}
  changeFiles(where:{change:{eq:$id}}){change path additions deletions}
}`;

/** Open, draft, merged or closed: the stored state, with a draft said as one. */
export const pullState = (c: Pick<Change, 'state' | 'draft'>) => (c.state === 'open' && c.draft ? 'Draft' : stateWord[c.state] ?? c.state);
const tone = (c: Pick<Change, 'state' | 'draft' | 'waitingOn'>): Tone => (c.state === 'merged' ? 'good' : c.state !== 'open' || c.draft ? 'muted' : c.waitingOn === 'you' ? 'waiting' : 'working');
/** The pull request's own page on GitHub, and only a GitHub address: anything else draws no link. */
export const pullHref = (url: string | null | undefined) => (url && /^https:\/\/github\.com\/[^\s]+$/.test(url) ? url : null);
const checkTone = (state: string): Tone => (state === 'failing' ? 'bad' : state === 'passing' ? 'good' : state === 'running' ? 'working' : 'muted');
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
  if (form === 'compact') return <p className="board-brief"><State tone={tone(c)}>{pullState(c)}</State> {c.state === 'open' ? <><b>{waitingWord(c)}</b> · </> : null}#{c.number} {c.title}</p>;
  // A linked ticket is shown only when the member may read the ticket itself, as the desktop does.
  const tickets = (read.data?.changeTasks ?? []).flatMap((link) => (link.taskRow && link.taskRow.id === link.task ? [link.taskRow] : []));
  const checks = [...(read.data?.changeChecks ?? [])].sort((a, b) => a.state.localeCompare(b.state));
  const people = read.data?.changePeople ?? [];
  const files = [...(read.data?.changeFiles ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  return (
    <>
      <Lead>{c.title}</Lead>
      <div className="board-meta">
        <State tone={tone(c)}>{pullState(c)}</State>
        {form === 'primary' && <span className="font-mono">#{c.number}</span>}
        <Chip place={{ brick: 'repository', params: { repository: c.repository } }}>{c.repository}</Chip>
        {c.project && <Chip place={{ brick: 'project', params: { project: c.project } }}>{c.project}</Chip>}
        {c.agent && <Chip place={{ brick: 'agent', params: { agent: c.agent } }}>{c.agent}</Chip>}
        {form === 'side' && tickets.map((t) => <span key={t.id} title={t.title}>{ticketChip(t.id)}</span>)}
      </div>
      <Note>{summary(c)}</Note>
      {pullHref(c.url) && <Note><a href={pullHref(c.url)!} target="_blank" rel="noopener noreferrer">Open on GitHub</a></Note>}
      {form === 'primary' && (
        <>
          <Facts>
            <Fact label="Branch"><span><span className="font-mono">{c.branch}</span> into <span className="font-mono">{c.baseBranch}</span>, opened by {c.authorLogin}</span></Fact>
            <Fact label="Checks"><span className="board-pull-list"><span>{checksWord[c.checks] ?? c.checks}</span>{checks.map((k) => <State key={k.name} tone={checkTone(k.state)}>{checkWord[k.state] ?? k.state}: {k.name}</State>)}</span></Fact>
            <Fact label="Review">{reviewWord[c.review] ?? c.review}</Fact>
            <Fact label="Can be merged">{mergeableWord[c.mergeable] ?? c.mergeable}</Fact>
            {people.length > 0 && <Fact label="People on it"><span className="board-pull-list">{people.map((p) => <span key={p.login + ':' + p.role}>{roleWord[p.role] ?? p.role}: {p.login}</span>)}</span></Fact>}
            {c.state === 'open' && c.waitingOn === 'you' && <Fact label="Merge"><span className="board-note">The merge is answered in Changes on the desktop.</span></Fact>}
          </Facts>
          <Section title="Files changed" count={files.length || undefined}>
            {files.length > 0
              ? <Rows label="Files changed" beside>{files.map((f) => <Row key={f.path} title={<span className="font-mono">{f.path}</span>} end={<span className="font-mono">+{f.additions} −{f.deletions}</span>} />)}</Rows>
              : <Note>Which files it changes is not known yet.</Note>}
          </Section>
          {tickets.length > 0 && (
            <Section title="Tickets">
              <Rows>{tickets.map((t) => <Row key={t.id} place={{ brick: 'ticket', params: { ticket: t.id } }} title={<>{t.title} <span className="font-mono board-row-ref">{t.id}</span></>} />)}</Rows>
            </Section>
          )}
        </>
      )}
    </>
  );
}
