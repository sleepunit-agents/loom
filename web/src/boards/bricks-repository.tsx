/** The `repository` brick: a repository's open pull requests, each a `pull` chip, read from the `changes` rows.
 * Loom gives a member no read of the repositories bound to a project (`project_repositories` is not in the
 * query layer), so a repository is known here only by the pull requests loom has read for it. */
import { useDataQuery } from '../data/graphql';
import { rowWord, type Change } from '../pieces/change-view/model';
import { Chip, Loading, Unavailable, repositoryKey, words, type Params } from './brick-kit';
import type { Form } from './layout';

type Row = Pick<Change, 'id' | 'number' | 'title' | 'state' | 'draft' | 'checks' | 'review' | 'waitingOn' | 'agent' | 'project'>;
export { repositoryKey };
export const repositoryQuery = (inProject: boolean) => {
  const where = `repository:{eq:$repository}${inProject ? ',project:{eq:$project}' : ''}`;
  return `query BrickRepository($repository:String!${inProject ? ',$project:String!' : ''}){
  open:changes(where:{${where},state:{eq:open}},orderBy:{updatedAt:{direction:desc,priority:0}},limit:30){id number title state draft checks review waitingOn agent project}
  known:changes(where:{${where}},limit:1){id}
}`;
};
export const pullChip = (c: Pick<Change, 'id' | 'number'>) => <Chip place={{ brick: 'pull', params: { change: c.id } }}>#{c.number}</Chip>;

export function Repository({ params, form }: { params: Params; form: Form }) {
  const project = words(params.project);
  const read = useDataQuery<{ open: Row[]; known: { id: string }[] }>(repositoryQuery(!!project),
    { repository: repositoryKey(words(params.repository)), ...(project ? { project } : {}) }, { keep: true });
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !read.data?.known.length) return <Unavailable what="repository" />;
  const rows = read.data.open, yours = rows.filter((c) => c.waitingOn === 'you').length;
  const count = `${rows.length === 30 ? 'At least thirty' : rows.length || 'No'} open pull request${rows.length === 1 ? '' : 's'}`;
  if (form === 'compact') return <p className="board-brief">{count}{yours ? ` · ${yours} waiting on you` : ''}</p>;
  if (!rows.length) return <p className="text-muted-foreground">No open pull requests.</p>;
  return (
    <>
      <p>{count}{yours ? `, ${yours} waiting on you` : ''}.</p>
      {form === 'primary'
        ? <ul className="board-notes">{rows.map((c) => <li key={c.id}><span className="board-line" style={{ marginTop: 0 }}>{pullChip(c)}<span>{c.title}</span></span><small>{rowWord(c)}</small></li>)}</ul>
        : <div className="board-line">{rows.map((c) => <span key={c.id} title={c.title}>{pullChip(c)}</span>)}</div>}
    </>
  );
}
