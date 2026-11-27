/** The `repository` brick: a repository's open pull requests, each a `pull` chip, read from the `changes` rows.
 * Loom gives a member no read of the repositories bound to a project (`project_repositories` is not in the
 * query layer), so a repository is known here only by the pull requests loom has read for it. */
import { useDataQuery } from '../data/graphql';
import { rowWord, type Change } from '../pieces/change-view/model';
import { Chip, Few, Loading, More, Note, Row, Rows, Unavailable, repositoryKey, words, type Params } from './brick-kit';
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
  const total = `${rows.length === 30 ? 'At least thirty' : rows.length || 'No'} open pull request${rows.length === 1 ? '' : 's'}`;
  if (form === 'compact') return <p className="board-brief">{total}{yours ? ` · ${yours} waiting on you` : ''}</p>;
  if (!rows.length) return <Note>No open pull requests.</Note>;
  const big = form === 'primary';
  return (
    <>
      <Note>{total}{yours ? `, ${yours} waiting on you` : ''}.</Note>
      <Few of={rows} first={big ? rows.length : 3} fit={!big}>{(shown, hidden) => <>
      <Rows>
        {shown.map((c) => (
          <Row key={c.id} place={{ brick: 'pull', params: { change: c.id } }}
            title={<><span className="font-mono board-repository-number">#{c.number}</span> {c.title}</>} meta={rowWord(c)} />
        ))}
      </Rows>
      <More n={hidden} />
      </>}</Few>
    </>
  );
}
