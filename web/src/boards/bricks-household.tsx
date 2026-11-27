/** The `household` brick: the desktop's Household setup (pieces/household) on a board, for a household owner. It
 * reads that app's two selections (pieces/household/model.ts); `householdSetup` answers an owner and nobody else,
 * and anyone else is told the setup is unavailable. Tokens and browsers are shown by label and state: loom serves
 * no token's value, and none is shown. Revoking a token and signing a browser out are the desktop's own calls
 * (signin/session-change.ts over `token.revoke` and `sessions.revoke`), asked first. An outside program's grants are
 * saved by `program.setGrants`. What the desktop changes by a message to the agent (a member, an agent's appearance
 * and accounts, a restore) is said so here: the conversation is beside the board. Making a token shows its value
 * once, and a portrait is two chosen files read in the browser: both are left to the desktop. */
import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { liveAgents } from '../data/live-agents';
import { memberOperation } from '../data/operation';
import { fullTime } from '../kit/time';
import { agentOwnership, householdSetupQuery, programLine, programNote, programQuery, sessionLine, setupWords, tokenState, type HouseholdSetup, type ProgramSetupData } from '../pieces/household/model';
import { sessionChange } from '../signin/session-change';
import { isMember, isRef } from './admin-data';
import { Chip, Loading, Unavailable, type BodyProps } from './brick-kit';

const agentChip = (id: string) => (isRef(id) ? <Chip key={id} place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip> : <span key={id}>{id}</span>);
const memberChip = (id: string) => (isMember(id) ? <Chip key={id} place={{ brick: 'person', params: { person: 'member:' + id } }}>{id}</Chip> : <span key={id}>{id}</span>);

type Program = ProgramSetupData['tokens'][number];
function Grants({ token, catalogue, busy, save }: { token: Program; catalogue: ProgramSetupData['catalogue']; busy: boolean; save: (input: { fingerprint: string; records: string[]; operations: string[] }) => void }) {
  const [open, setOpen] = useState(false), [records, setRecords] = useState(token.records), [operations, setOperations] = useState(token.operations);
  const toggle = (list: string[], name: string) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]);
  const group = (label: string, names: string[], chosen: string[], set: (next: string[]) => void) => (
    <div className="board-line" role="group" aria-label={label}>{label}
      {names.map((name) => <button key={name} type="button" className="board-action" aria-pressed={chosen.includes(name)} disabled={busy || token.ended} onClick={() => set(toggle(chosen, name))}>{name}</button>)}
    </div>
  );
  return (
    <div style={{ marginBottom: '.5rem' }}>
      <div className="board-line">
        <strong>{token.label}</strong><span className="text-muted-foreground">{programLine(token)}</span>
        <span className="text-muted-foreground">{token.records.length} record type{token.records.length === 1 ? '' : 's'} · {token.operations.length} operation{token.operations.length === 1 ? '' : 's'}</span>
        {!token.ended && <button type="button" className="board-action" aria-expanded={open} onClick={() => setOpen(!open)}>Grants</button>}
      </div>
      {open && !token.ended && (
        <>
          {group('Record types', catalogue.records, records, setRecords)}
          {group('Operations', catalogue.operations, operations, setOperations)}
          <div className="board-line"><button type="button" className="board-action" disabled={busy} onClick={() => save({ fingerprint: token.fingerprint, records, operations })}>Save program grants</button></div>
        </>
      )}
    </div>
  );
}

export function Household({ form, act }: BodyProps) {
  const primary = form === 'primary';
  const feed = useDataQuery<{ householdSetup: HouseholdSetup | null }>(householdSetupQuery, undefined, { keep: true });
  const programFeed = useDataQuery<{ programSetup: ProgramSetupData | null }>(programQuery, undefined, { keep: true, pause: !primary });
  const [busy, setBusy] = useState(false), [message, say] = useState(''), [asking, setAsking] = useState('');
  if (feed.status === 'loading') return <Loading />;
  const setup = feed.status === 'live' ? feed.data?.householdSetup : null;
  if (!setup) return <Unavailable what="household setup" />;
  const agents = liveAgents(setup.agents), removed = setup.agents.filter((agent) => agent.removedAt);
  const tokens = setup.tokens.filter((token) => tokenState(token) === 'Active').length, browsers = setup.sessions.filter((session) => !session.ended).length;
  const count = `${setup.members.length} member${setup.members.length === 1 ? '' : 's'} · ${agents.length} agent${agents.length === 1 ? '' : 's'} · ${tokens} active token${tokens === 1 ? '' : 's'} · ${browsers} signed-in browser${browsers === 1 ? '' : 's'}`;
  if (form === 'compact') return <p className="board-brief">{count}</p>;
  const programs = primary && programFeed.status === 'live' ? programFeed.data?.programSetup : null;
  const change = async (name: 'token.revoke' | 'sessions.revoke' | 'program.setGrants', input: object, report: string) => {
    if (busy) return;
    setBusy(true); say('');
    try {
      if (name === 'program.setGrants') await memberOperation(name, input);
      else if (await sessionChange(name, input) === 'signed-out') return;
      act(report, {}); say(setupWords.saved); setAsking('');
    } catch { say(name === 'program.setGrants' ? setupWords.notSaved : setupWords.notRevoked); }
    finally { setBusy(false); }
  };
  return (
    <>
      <p className="board-line"><span>{count}</span></p>
      {message && <p role="status">{message}</p>}
      <dl>
        <div>
          <dt>Members</dt>
          <dd>
            {setup.members.map((member) => (
              <div className="board-line" key={member.id}>
                {memberChip(member.id)}
                <span className="board-state">{member.role === 'owner' ? 'Household owner' : 'Member'}</span>
                {member.fullOwner ? <span className="text-muted-foreground">Owns every agent, present and future</span>
                  : primary && <>{member.agents.filter((id) => agents.some((agent) => agent.id === id)).map(agentChip)}{!member.agents.length && <span className="text-muted-foreground">Owns no agent</span>}</>}
              </div>
            ))}
          </dd>
        </div>
        <div>
          <dt>Agents</dt>
          <dd>
            <p className="text-muted-foreground">Default agent: {setup.defaultAgent ?? 'None'}</p>
            {agents.map((agent) => (
              <div key={agent.id}>
                <div className="board-line">{agentChip(agent.id)}<span className="text-muted-foreground">{agentOwnership(setup.members, agent.id)}</span></div>
                {primary && <p className="text-muted-foreground">{agent.about || 'No description'} · GitHub accounts: {agent.github.join(', ') || 'none'} · {agent.spriteVersion ? 'Animated portrait' : 'Generated face'}</p>}
              </div>
            ))}
            {primary && !!removed.length && <p className="text-muted-foreground">Removed: {removed.map((agent) => agent.id).join(', ')}</p>}
          </dd>
        </div>
        {primary && (
          <div>
            <dt>Tokens</dt>
            <dd>
              {!setup.tokens.length && <p className="text-muted-foreground">No tokens</p>}
              {setup.tokens.map((token) => (
                <div key={token.fingerprint} style={{ marginBottom: '.5rem' }}>
                  <div className="board-line">
                    <strong>{token.label}</strong><span>{token.kind} · {token.identity}</span><span className="board-state">{tokenState(token)}</span>
                    {!token.revokedAt && (asking === 'token:' + token.fingerprint
                      ? <><span>Revoke this token? Whatever uses it stops working, and it cannot be restored.</span><button type="button" className="board-action" disabled={busy} onClick={() => void change('token.revoke', { fingerprint: token.fingerprint }, 'revokeToken')}>Revoke it</button><button type="button" className="board-action" disabled={busy} onClick={() => setAsking('')}>Keep it</button></>
                      : <button type="button" className="board-action" disabled={busy} onClick={() => { say(''); setAsking('token:' + token.fingerprint); }}>Revoke token…</button>)}
                  </div>
                  <p className="text-muted-foreground">Created {fullTime(token.createdAt)} · Last used {token.lastUsedAt ? fullTime(token.lastUsedAt) : 'Never'}{token.expiresAt ? ` · Expires ${fullTime(token.expiresAt)}` : ''}</p>
                </div>
              ))}
            </dd>
          </div>
        )}
        {primary && (
          <div>
            <dt>Signed-in browsers</dt>
            <dd>
              {!setup.sessions.length && <p className="text-muted-foreground">No browsers</p>}
              {setup.sessions.map((session) => (
                <div key={session.ref} style={{ marginBottom: '.5rem' }}>
                  <div className="board-line">
                    <strong>{session.device}</strong><span>{sessionLine(session)}</span>
                    {asking === 'session:' + session.ref
                      ? <><span>Sign this browser out? It must sign in again.</span><button type="button" className="board-action" disabled={busy} onClick={() => void change('sessions.revoke', { ref: session.ref }, 'revokeSession')}>Sign it out</button><button type="button" className="board-action" disabled={busy} onClick={() => setAsking('')}>Keep it</button></>
                      : <button type="button" className="board-action" disabled={busy} onClick={() => { say(''); setAsking('session:' + session.ref); }}>Sign out browser…</button>}
                  </div>
                  <p className="text-muted-foreground">Last used {fullTime(session.seenAt)}</p>
                </div>
              ))}
            </dd>
          </div>
        )}
        {programs && (
          <div>
            <dt>Outside program grants</dt>
            <dd>
              <p className="text-muted-foreground">{programNote}</p>
              {!programs.tokens.length && <p>No outside program tokens yet.</p>}
              {programs.tokens.map((token) => <Grants key={JSON.stringify(token)} token={token} catalogue={programs.catalogue} busy={busy} save={(input) => void change('program.setGrants', input, 'setGrants')} />)}
            </dd>
          </div>
        )}
      </dl>
      {primary && (
        <>
          <p className="text-muted-foreground" style={{ marginTop: '.6rem' }}>To add or change a member, an agent’s description, badge, face or GitHub accounts, or to restore a removed agent, ask the agent in the conversation: it proposes the change and you answer it in the Inbox.</p>
          <p className="text-muted-foreground">A new token is made on the desktop, where its value is shown once. An agent’s animated portrait is changed there too.</p>
        </>
      )}
    </>
  );
}
