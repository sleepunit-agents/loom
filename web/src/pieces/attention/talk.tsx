import { useMemo, type ReactNode } from 'react';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import { Body, LinkButton, List, Meta, Row, Section } from '../../kit';
import { sinceWord } from './doing';
import { threadPath } from './home-comms-data';
import { stamp } from './time';

/** An agent's recent conversations and its last answer, in one request for one card. The server picks the
 * latest answered conversation before its limit; nothing here reads a thread or subscribes to one. */
export const cardTalkQuery = `query DeskCardTalk($agent: String!, $limit: Int!) {
  recent: recentConversations(agent: $agent, limit: $limit) { id agent label venue place lastAt }
  answered: recentConversations(agent: $agent, limit: 1, answeredOnly: true) { id agent venue place lastAnswer { at words } }
}`;
interface Wire { id: string; agent: string; label?: string; venue: string; place: string; lastAt?: string; lastAnswer?: { at: string; words: string } | null }
type Data = { recent: Wire[]; answered: Wire[] };
export interface Talk { id: string; title: string; at: string; path: string }
export interface CardTalk { status: DataQuerySnapshot<unknown>['status']; recent: Talk[]; answer?: { at: string; words: string; path: string } }
/** Where a conversation opens: a Comms thread for the app's own and a terminal's, its history for any other. */
export const talkPath = (row: { id: string; venue: string; place: string }) =>
  row.venue === 'loom' || row.venue === 'terminal' ? threadPath(row.place) : `/p/comms-preview/conversation/${encodeURIComponent(row.id)}`;
export function cardTalk(query: DataQuerySnapshot<Data>, agent: string, limit: number): CardTalk {
  if (query.status !== 'live') return { status: query.status, recent: [] };
  if (!query.data) return { status: 'loading', recent: [] };
  if (!Array.isArray(query.data.recent) || !Array.isArray(query.data.answered)) return { status: 'offline', recent: [] };
  const mine = (rows: Wire[]) => rows.filter(row => row.agent === agent);
  const answered = mine(query.data.answered).filter(row => row.lastAnswer)
    .sort((a, b) => b.lastAnswer!.at.localeCompare(a.lastAnswer!.at) || a.id.localeCompare(b.id))[0];
  return { status: 'live', answer: answered ? { ...answered.lastAnswer!, path: talkPath(answered) } : undefined,
    recent: mine(query.data.recent).sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.id.localeCompare(b.id)).slice(0, limit)
      .map(row => ({ id: row.id, title: row.label || 'Conversation', at: row.lastAt ?? '', path: talkPath(row) })) };
}
export function useCardTalk(agent: string, limit = 3): CardTalk {
  const query = useDataQuery<Data>(cardTalkQuery, { agent, limit });
  return useMemo(() => cardTalk(query, agent, limit), [query, agent, limit]);
}
const opens = (path: string, go: (path: string) => void) => ({ href: path, onClick(event: { button?: number; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; preventDefault(): void }) {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); go(path);
} });

/** Home's card: the last answer in three lines, the whole block opening its conversation; then the three most
 * recent conversations as quiet one-line links, and the way to the rest. Nothing is drawn for what there is none of. */
export function HomeTalk({ talk, name, unread = 0, firstUnread, all, go, composer }: {
  talk: CardTalk; name: string; unread?: number; firstUnread?: string; all: string; go(path: string): void; composer?: ReactNode;
}) {
  if (talk.status !== 'live') return <>{composer}</>;
  const answer = talk.answer, unreadPath = firstUnread ? threadPath(firstUnread) : undefined;
  return <>
    {answer && <a className="desk-home-answer" aria-label={`${name} last answer. Open the conversation`} {...opens(answer.path, go)}>
      <span className="desk-home-kicker">Last answer · <time dateTime={answer.at}>{sinceWord(answer.at)}</time></span>
      <span className="desk-home-answer-words">{answer.words}</span>
    </a>}
    {composer}
    {talk.recent.length > 0 && <nav className="desk-home-talks" aria-label={`${name} conversations`}>
      <span className="desk-home-kicker">Conversations{unread ? ` · ${unread} unread` : ''}</span>
      <ul>{talk.recent.map(row => <li key={row.id}><a className="desk-home-talk" title={row.title} data-unread={row.path === unreadPath || undefined} {...opens(row.path, go)}>
        {row.path === unreadPath && <span className="desk-home-unread" role="img" aria-label="Unread" />}
        <span className="desk-home-talk-title">{row.title}</span>{row.at && <time dateTime={row.at}>{sinceWord(row.at)}</time>}
      </a></li>)}</ul>
      <a className="desk-home-all" {...opens(all, go)}>All conversations ›</a>
    </nav>}
  </>;
}

/** The agent's own page: the last answer whole. */
export function LastAnswerSection({ talk, go }: { talk: CardTalk; go(path: string): void }) {
  if (talk.status !== 'live' || !talk.answer) return null;
  const answer = talk.answer;
  return <Section label="Last answer">
    <Body>{answer.words}</Body>
    <Meta><time dateTime={answer.at}>{stamp(Date.parse(answer.at))}</time></Meta>
    <LinkButton onClick={() => go(answer.path)}>Open the conversation</LinkButton>
  </Section>;
}
/** The agent's own page: its recent conversations, and Comms for every one of them. */
export function ConversationsSection({ talk, name, unread = 0, firstUnread, go }: { talk: CardTalk; name: string; unread?: number; firstUnread?: string; go(path: string): void }) {
  const unreadPath = firstUnread ? threadPath(firstUnread) : undefined;
  return <Section label={unread ? `Conversations · ${unread} unread` : 'Conversations'}>
    {talk.status === 'loading' ? <Body quiet>Checking…</Body> : talk.status !== 'live' ? <Body quiet>Can’t read conversations right now.</Body>
      : !talk.recent.length ? <Body quiet>None yet.</Body>
      : <List label={`${name} conversations`}>{talk.recent.map(row => <Row key={row.id} title={row.title} unread={row.path === unreadPath}
        meta={row.at ? sinceWord(row.at) : undefined} onClick={() => go(row.path)} />)}</List>}
    <LinkButton onClick={() => go('/p/comms-preview')}>All conversations in Comms</LinkButton>
  </Section>;
}
