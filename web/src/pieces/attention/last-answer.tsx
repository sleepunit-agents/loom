import { useDataQuery } from '../../data/graphql';
import { stamp } from './time';

/** The server selects the latest answered conversation before the limit. */
export const lastAnswerQuery = `query DeskLastAnswer($agent: String!) {
  recentConversations(agent: $agent, limit: 1, answeredOnly: true) {
    id agent lastAnswer { at words }
  }
}`;
type Answer = { at: string; words: string };
type Data = { recentConversations: { id: string; agent: string; lastAnswer: Answer | null }[] };
export function LastAnswer({ agent, name }: { agent: string; name: string }) {
  const query = useDataQuery<Data>(lastAnswerQuery, { agent });
  const current = query.status === 'live' && query.data;
  const answer = current ? current.recentConversations.filter(row => row.agent === agent && row.lastAnswer)
    .sort((a, b) => b.lastAnswer!.at.localeCompare(a.lastAnswer!.at) || a.id.localeCompare(b.id))[0]?.lastAnswer : undefined;
  return <section aria-label={`${name} last answer`}><h3>Last answer</h3>
    {!current ? <p>Answer unavailable.</p> : answer ? <>
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{answer.words}</p>
      <p><time dateTime={answer.at}>{stamp(Date.parse(answer.at))}</time></p>
    </> : <p>No retained agent answer.</p>}
  </section>;
}
