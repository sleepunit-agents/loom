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
import { fullTime } from '../kit/time';
import { bridgeCommand, commandWords } from '../pieces/bridges/command';
import { activityLine, awaitingReview, bridgeLabels, bridgesQuery, bridgesSnapshot, sendNotes, type BridgesData } from '../pieces/bridges/data';
import { isMember, isRef } from './admin-data';
import { Chip, Loading, Unavailable, useOwnFlag, type Act, type BodyProps } from './brick-kit';

type Send = BridgesData['bridgeSends'][number];
const agentChip = (id: string) => (isRef(id) ? <Chip place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip> : <span>{id}</span>);

function Review({ row, act }: { row: Send; act: Act }) {
  const [asking, setAsking] = useState<'release' | 'dismiss' | ''>(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const pending = useRef(false);
  if (!['held', 'uncertain'].includes(row.state)) return null;
  const run = async (decision: 'release' | 'dismiss') => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage('');
    try {
      const saved = await bridgeCommand({ action: 'review', id: row.id, decision });
      if (saved) act(decision, {});
      setMessage(saved ? commandWords.saved : commandWords.notConfirmed); setAsking('');
    } finally { pending.current = false; setBusy(false); }
  };
  return (
    <div className="board-line">
      {asking === 'release' ? <><span>Send this reply to {row.channel}? It cannot be taken back.</span><button type="button" className="board-action" disabled={busy} onClick={() => void run('release')}>Release it</button><button type="button" className="board-action" disabled={busy} onClick={() => setAsking('')}>Keep it held</button></>
        : asking === 'dismiss' ? <><span>Dismiss this reply? It will never be sent.</span><button type="button" className="board-action" disabled={busy} onClick={() => void run('dismiss')}>Dismiss it</button><button type="button" className="board-action" disabled={busy} onClick={() => setAsking('')}>Keep it</button></>
        : <>
            {row.state === 'held' && <button type="button" className="board-action" onClick={() => { setMessage(''); setAsking('release'); }}>Release send…</button>}
            <button type="button" className="board-action" onClick={() => { setMessage(''); setAsking('dismiss'); }}>Dismiss send…</button>
          </>}
      {message && <span role="status">{message}</span>}
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
  const waiting = `${sends.length} pending send${sends.length === 1 ? '' : 's'}`;
  const count = manage ? `${snapshot.connections.length} connection${snapshot.connections.length === 1 ? '' : 's'} · ${waiting}` : waiting;
  if (form === 'compact') return <p className="board-brief">{count}</p>;
  const cap = primary ? 40 : 4;
  return (
    <>
      <p className="board-line"><span>{count}</span></p>
      <dl>
        <div>
          <dt>{bridgeLabels.sends}</dt>
          <dd>
            {!sends.length && <p className="text-muted-foreground">No pending sends</p>}
            {sends.slice(0, cap).map((send) => (
              <div key={send.id} style={{ marginBottom: '.5rem' }}>
                <div className="board-line"><strong>Reply to {send.channel}</strong><span className="board-state">{send.state}</span>{primary && <span className="text-muted-foreground">{fullTime(send.createdAt)}</span>}</div>
                <p className="board-tail">{send.text}</p>
                {primary && send.thread && <p className="text-muted-foreground">Thread: {send.thread}</p>}
                {primary && send.state === 'uncertain' && <p>{sendNotes.uncertain}</p>}
                {primary && send.state === 'held' && <p>{sendNotes.held}</p>}
                {primary && <Review key={JSON.stringify(send)} row={send} act={act} />}
              </div>
            ))}
            {sends.length > cap && <p className="text-muted-foreground">and {sends.length - cap} more</p>}
          </dd>
        </div>
        {manage && (
          <div>
            <dt>{bridgeLabels.connections}</dt>
            <dd>
              {!snapshot.connections.length && <p className="text-muted-foreground">No connections</p>}
              {snapshot.connections.map((connection) => {
                const activity = recent.get(connection.id);
                return (
                  <div key={connection.id} style={{ marginBottom: '.5rem' }}>
                    <div className="board-line">{agentChip(connection.agent)}<span>{connection.platform}</span><span className="board-state" data-running={connection.state === 'connected'}>{connection.state}</span><span className="board-state">{connection.enabled ? 'Enabled' : 'Disabled'}</span></div>
                    <p className="text-muted-foreground">{connection.workspace}{activity ? ` · ${activityLine(activity)} in 24 hours` : ''}</p>
                    {primary && (
                      <>
                        <p className="text-muted-foreground">State changed {fullTime(connection.stateAt)} · Bot user {connection.botUser}</p>
                        {(['only', 'ignore'] as const).map((rule) => <p key={rule} className="text-muted-foreground">{rule === 'only' ? 'Only channels' : 'Ignored channels'}: {snapshot.filters.filter((filter) => filter.connection === connection.id && filter.rule === rule).map((filter) => filter.channel).join(', ') || 'None'}</p>)}
                        <p className="text-muted-foreground">Stored secret names · Bot token: {connection.tokenSecret}{connection.appSecret ? ` · App token: ${connection.appSecret}` : ''}</p>
                      </>
                    )}
                  </div>
                );
              })}
            </dd>
          </div>
        )}
        {manage && primary && (
          <div>
            <dt>{bridgeLabels.channels}</dt>
            <dd>
              {!snapshot.channels.length && <p className="text-muted-foreground">No channel rules</p>}
              {snapshot.channels.map((channel) => (
                <div className="board-line" key={JSON.stringify([channel.platform, channel.workspace, channel.channel])}>
                  <strong>{channel.channel}</strong><span className="text-muted-foreground">{channel.platform} · {channel.workspace}</span>
                  <span>Answers when nobody is addressed:</span>{agentChip(channel.answers)}<span className="text-muted-foreground">Bots may talk: {channel.botsMayTalk ? 'Yes' : 'No'}</span>
                </div>
              ))}
            </dd>
          </div>
        )}
        {manage && primary && (
          <div>
            <dt>{bridgeLabels.people}</dt>
            <dd>
              {!snapshot.people.length && <p className="text-muted-foreground">No person links</p>}
              {snapshot.people.map((person) => (
                <div className="board-line" key={JSON.stringify([person.platform, person.workspace, person.user])}>
                  {isMember(person.member) ? <Chip place={{ brick: 'person', params: { person: 'member:' + person.member } }}>{person.member}</Chip> : <span>{person.member}</span>}
                  <span className="text-muted-foreground">{person.platform} · {person.workspace} · Outside user: {person.user}</span>
                </div>
              ))}
            </dd>
          </div>
        )}
      </dl>
      {manage && primary && <p className="text-muted-foreground" style={{ marginTop: '.6rem' }}>To add, change or remove a connection, a channel rule or a person link, ask the agent in the conversation: it proposes the change and you answer it in the Inbox.</p>}
    </>
  );
}
