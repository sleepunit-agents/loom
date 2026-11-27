/** The `bridges` brick: the desktop's Bridges app (pieces/bridges, pieces/bridges-view.tsx) on a board. It reads
 * that app's one selection (pieces/bridges/data.ts): loom sends each member the rows they may read, so someone who
 * does not run the household's bridges sees only the replies they may review. A reply that did not go out is
 * released or dismissed through the desktop's own door (pieces/bridges/command.ts, `/api/bridges/command`), after
 * asking: a release sends its words outside the household, and neither can be undone. A reply's words are drawn
 * where the desktop draws them and go nowhere else. A connection, a channel rule and a person link are changed on
 * the desktop by a message to the agent, who files the proposal: here that is said, and the conversation is beside
 * the board. Secrets are named, as on the desktop; loom serves no secret's value. */
import { useRef, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { bridgeCommand, commandWords } from '../pieces/bridges/command';
import { activityLine, awaitingReview, bridgeLabels, bridgesQuery, bridgesSnapshot, sendNotes, type BridgesData } from '../pieces/bridges/data';
import { isMember, isRef } from './admin-data';
import { Chip, Confirm, Excerpt, Fact, Facts, Few, Lead, Loading, More, Note, Row, Rows, Section, State, Time, Unavailable, count, useOwnFlag, type Act, type BodyProps, type Tone } from './brick-kit';

type Send = BridgesData['bridgeSends'][number];
const agentChip = (id: string) => (isRef(id) ? <Chip place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip> : <span>{id}</span>);

const sendTone = (state: string): Tone => (state === 'held' ? 'waiting' : state === 'uncertain' ? 'bad' : 'neutral');
const connectionTone = (state: string): Tone => (state === 'connected' ? 'good' : /fail|error|invalid|revoked/.test(state) ? 'bad' : state === 'connecting' ? 'working' : 'neutral');

function Review({ row, act }: { row: Send; act: Act }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const pending = useRef(false);
  if (!['held', 'uncertain'].includes(row.state)) return null;
  const run = async (decision: 'release' | 'dismiss') => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setMessage('');
    try {
      const saved = await bridgeCommand({ action: 'review', id: row.id, decision });
      if (saved) act(decision, {});
      setMessage(saved ? commandWords.saved : commandWords.notConfirmed); return true;
    } finally { pending.current = false; setBusy(false); }
  };
  return (
    <div className="board-actions board-bridges-review">
      {row.state === 'held' && <Confirm kind="primary" ask="Release send…" yes="Release it" no="Keep it held" busy={busy} act={() => run('release')}>Send this reply to {row.channel}? It cannot be taken back.</Confirm>}
      <Confirm ask="Dismiss send…" yes="Dismiss it" no="Keep it" busy={busy} act={() => run('dismiss')}>Dismiss this reply? It will never be sent.</Confirm>
      {message && <span role="status" className="board-note">{message}</span>}
    </div>
  );
}

export function Bridges({ form, act, raise }: BodyProps) {
  const primary = form === 'primary';
  const query = useDataQuery<BridgesData>(bridgesQuery, undefined, { keep: true }), snapshot = bridgesSnapshot(query);
  const held = snapshot.status === 'live' ? snapshot.sends.filter((send) => send.state === 'held').length : undefined;
  useOwnFlag(held, raise, (was, now) => (now > was ? 'Held send' : null));
  if (snapshot.status === 'loading') return <Loading />;
  if (snapshot.status !== 'live') return <Unavailable what="list of bridges" />;
  const manage = query.data?.bridgeReader?.manage === true;
  const sends = snapshot.sends.filter(awaitingReview), recent = new Map(snapshot.activity.map((entry) => [entry.connection, entry]));
  const waiting = count(sends.length, 'pending send');
  const summary = manage ? `${count(snapshot.connections.length, 'connection')} · ${waiting}` : waiting;
  if (form === 'compact') return <p className="board-brief">{summary}</p>;
  const cap = primary ? 40 : 3;
  const filters = (connection: string, rule: 'only' | 'ignore') => snapshot.filters.filter((filter) => filter.connection === connection && filter.rule === rule).map((filter) => filter.channel).join(', ') || 'None';
  return (
    <>
      <Lead>{summary}</Lead>
      <Section title={bridgeLabels.sends} count={sends.length || undefined}>
        {!sends.length ? <Note>No pending sends</Note> : (
          <Few of={sends} first={cap} fit={!primary}>{(shown, hidden) => <>
          <Rows>
            {shown.map((send) => (
              <Row key={send.id} flagged={send.state === 'held'} title={<>Reply to {send.channel}</>} end={<><State tone={sendTone(send.state)}>{send.state}</State>{primary && <Time at={send.createdAt} />}</>}
                meta={primary && send.thread ? <>Thread: {send.thread}</> : undefined}>
                {primary ? <p className="board-tail board-bridges-text">{send.text}</p> : <Excerpt lines={2}><p className="board-bridges-text">{send.text}</p></Excerpt>}
                {primary && send.state === 'uncertain' && <Note>{sendNotes.uncertain}</Note>}
                {primary && send.state === 'held' && <Note>{sendNotes.held}</Note>}
                {primary && <Review key={JSON.stringify(send)} row={send} act={act} />}
              </Row>
            ))}
          </Rows>
          <More n={hidden} />
          </>}</Few>
        )}
      </Section>
      {manage && primary && (
        <Section title={bridgeLabels.connections} count={snapshot.connections.length || undefined}>
          {!snapshot.connections.length ? <Note>No connections</Note> : (
            <Rows>
              {snapshot.connections.map((connection) => {
                const activity = recent.get(connection.id);
                return (
                  <Row key={connection.id} title={<>{agentChip(connection.agent)} {connection.platform}</>}
                    meta={primary ? <>{connection.workspace}{activity ? ` · ${activityLine(activity)} in 24 hours` : ''}</> : undefined}
                    end={<><State tone={connectionTone(connection.state)}>{connection.state}</State>{(primary || !connection.enabled) && <State tone={connection.enabled ? 'neutral' : 'muted'}>{connection.enabled ? 'Enabled' : 'Disabled'}</State>}</>}>
                    {primary && (
                      <Facts>
                        <Fact label="State changed"><Time at={connection.stateAt} /></Fact>
                        <Fact label="Bot user">{connection.botUser}</Fact>
                        <Fact label="Only channels">{filters(connection.id, 'only')}</Fact>
                        <Fact label="Ignored channels">{filters(connection.id, 'ignore')}</Fact>
                        <Fact label="Stored secret names"><span>Bot token: <span className="font-mono">{connection.tokenSecret}</span>{connection.appSecret ? <> · App token: <span className="font-mono">{connection.appSecret}</span></> : null}</span></Fact>
                      </Facts>
                    )}
                  </Row>
                );
              })}
            </Rows>
          )}
        </Section>
      )}
      {manage && primary && (
        <Section title={bridgeLabels.channels} count={snapshot.channels.length || undefined}>
          {!snapshot.channels.length ? <Note>No channel rules</Note> : (
            <Rows>
              {snapshot.channels.map((channel) => (
                <Row key={JSON.stringify([channel.platform, channel.workspace, channel.channel])} title={channel.channel} end={<span>{channel.platform} · {channel.workspace}</span>}
                  meta={<>Answers when nobody is addressed: {agentChip(channel.answers)} · Bots may talk: {channel.botsMayTalk ? 'Yes' : 'No'}</>} />
              ))}
            </Rows>
          )}
        </Section>
      )}
      {manage && primary && (
        <Section title={bridgeLabels.people} count={snapshot.people.length || undefined}>
          {!snapshot.people.length ? <Note>No person links</Note> : (
            <Rows>
              {snapshot.people.map((person) => (
                <Row key={JSON.stringify([person.platform, person.workspace, person.user])}
                  title={isMember(person.member) ? <Chip place={{ brick: 'person', params: { person: 'member:' + person.member } }}>{person.member}</Chip> : person.member}
                  end={<span>{person.platform} · {person.workspace}</span>} meta={<>Outside user: <span className="font-mono">{person.user}</span></>} />
              ))}
            </Rows>
          )}
        </Section>
      )}
      {manage && primary && <Note>To add, change or remove a connection, a channel rule or a person link, ask the agent in the conversation: it proposes the change and you answer it in the Inbox.</Note>}
    </>
  );
}
