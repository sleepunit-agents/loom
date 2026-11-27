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
import { agentOwnership, householdSetupQuery, programLine, programNote, programQuery, sessionLine, setupWords, tokenState, type HouseholdSetup, type ProgramSetupData } from '../pieces/household/model';
import { sessionChange } from '../signin/session-change';
import { isMember, isRef } from './admin-data';
import { Action, Actions, AskRow, Chip, Fact, Facts, Lead, Loading, Note, Opened, Opens, Row, Rows, Section, State, Time, Unavailable, count, type BodyProps, type Tone } from './brick-kit';

const agentChip = (id: string) => (isRef(id) ? <Chip key={id} place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip> : <span key={id}>{id}</span>);
const memberChip = (id: string) => (isMember(id) ? <Chip key={id} place={{ brick: 'person', params: { person: 'member:' + id } }}>{id}</Chip> : <span key={id}>{id}</span>);

const tokenTone = (state: string): Tone => (state === 'Active' ? 'good' : state === 'Expired' ? 'waiting' : 'muted');

type Program = ProgramSetupData['tokens'][number];
function Grants({ token, catalogue, busy, save }: { token: Program; catalogue: ProgramSetupData['catalogue']; busy: boolean; save: (input: { fingerprint: string; records: string[]; operations: string[] }) => void }) {
  const [open, setOpen] = useState(false), [records, setRecords] = useState(token.records), [operations, setOperations] = useState(token.operations);
  const toggle = (list: string[], name: string) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]);
  const group = (label: string, names: string[], chosen: string[], set: (next: string[]) => void) => (
    <div className="board-choice" role="group" aria-label={label}>
      <span className="board-choice-label">{label}</span>
      <Actions>{names.map((name) => <Action key={name} pressed={chosen.includes(name)} disabled={busy || token.ended} onClick={() => set(toggle(chosen, name))}>{name}</Action>)}</Actions>
    </div>
  );
  return (
    <Row title={token.label} meta={<>{programLine(token)}<br />{count(token.records.length, 'record type')} · {count(token.operations.length, 'operation')}</>}
      end={token.ended ? undefined : <Opens open={open} onToggle={() => setOpen(!open)}>Grants</Opens>}>
      {open && !token.ended && (
        <Opened>
          {group('Record types', catalogue.records, records, setRecords)}
          {group('Operations', catalogue.operations, operations, setOperations)}
          <Actions><Action kind="primary" disabled={busy} onClick={() => save({ fingerprint: token.fingerprint, records, operations })}>Save program grants</Action></Actions>
        </Opened>
      )}
    </Row>
  );
}

export function Household({ form, act }: BodyProps) {
  const primary = form === 'primary';
  const feed = useDataQuery<{ householdSetup: HouseholdSetup | null }>(householdSetupQuery, undefined, { keep: true });
  const programFeed = useDataQuery<{ programSetup: ProgramSetupData | null }>(programQuery, undefined, { keep: true, pause: !primary });
  const [busy, setBusy] = useState(false), [message, say] = useState('');
  if (feed.status === 'loading') return <Loading />;
  const setup = feed.status === 'live' ? feed.data?.householdSetup : null;
  if (!setup) return <Unavailable what="household setup" />;
  const agents = liveAgents(setup.agents), removed = setup.agents.filter((agent) => agent.removedAt);
  const tokens = setup.tokens.filter((token) => tokenState(token) === 'Active').length, browsers = setup.sessions.filter((session) => !session.ended).length;
  const summary = `${count(setup.members.length, 'member')} · ${count(agents.length, 'agent')}`, access = `${count(tokens, 'active token')} · ${count(browsers, 'signed-in browser')}`;
  if (form === 'compact') return <p className="board-brief">{summary} · {access}</p>;
  const programs = primary && programFeed.status === 'live' ? programFeed.data?.programSetup : null;
  const change = async (name: 'token.revoke' | 'sessions.revoke' | 'program.setGrants', input: object, report: string) => {
    if (busy) return false;
    setBusy(true); say('');
    try {
      if (name === 'program.setGrants') await memberOperation(name, input);
      else if (await sessionChange(name, input) === 'signed-out') return false;
      act(report, {}); say(setupWords.saved); return true;
    } catch { say(name === 'program.setGrants' ? setupWords.notSaved : setupWords.notRevoked); return false; }
    finally { setBusy(false); }
  };
  if (!primary) return (
    <>
      <Lead>{summary}</Lead>
      <Facts>
        <Fact label="Members">{setup.members.map((member) => <span key={member.id} className="board-household-who">{memberChip(member.id)} {member.role === 'owner' ? 'Household owner' : 'Member'}</span>)}</Fact>
        <Fact label="Agents">{agents.map((agent) => <span key={agent.id} className="board-household-who">{agentChip(agent.id)} {agentOwnership(setup.members, agent.id)}</span>)}</Fact>
      </Facts>
      <Note>Default agent: {setup.defaultAgent ?? 'None'} · {access}</Note>
    </>
  );
  return (
    <>
      <Lead>{summary}</Lead>
      <div className="board-meta"><span>{access}</span></div>
      {message && <p role="status" className="board-note">{message}</p>}
      <Section title="Members" count={setup.members.length}>
        <Rows>
          {setup.members.map((member) => (
            <Row key={member.id} title={memberChip(member.id)} end={<State tone={member.role === 'owner' ? 'working' : 'neutral'}>{member.role === 'owner' ? 'Household owner' : 'Member'}</State>}
              meta={member.fullOwner ? 'Owns every agent, present and future'
                : primary ? (member.agents.length ? <>Owns {member.agents.filter((id) => agents.some((agent) => agent.id === id)).map(agentChip)}</> : 'Owns no agent') : undefined} />
          ))}
        </Rows>
      </Section>
      <Section title="Agents" count={agents.length}>
        <Rows>
          {agents.map((agent) => (
            <Row key={agent.id} title={agentChip(agent.id)} end={<span>{agentOwnership(setup.members, agent.id)}</span>}
              meta={primary ? <>{agent.about || 'No description'} · GitHub accounts: {agent.github.join(', ') || 'none'} · {agent.spriteVersion ? 'Animated portrait' : 'Generated face'}</> : undefined} />
          ))}
        </Rows>
        <Note>Default agent: {setup.defaultAgent ?? 'None'}{primary && !!removed.length && <> · Removed: {removed.map((agent) => agent.id).join(', ')}</>}</Note>
      </Section>
      {primary && (
        <Section title="Tokens" count={setup.tokens.length || undefined}>
          {!setup.tokens.length ? <Note>No tokens</Note> : (
            <Rows>
              {setup.tokens.map((token) => {
                const line = <>{token.kind} · {token.identity}<br />Created <Time at={token.createdAt} /> · Last used {token.lastUsedAt ? <Time at={token.lastUsedAt} /> : 'Never'}{token.expiresAt && <> · Expires <Time at={token.expiresAt} /></>}</>;
                const state = <State tone={tokenTone(tokenState(token))}>{tokenState(token)}</State>;
                return token.revokedAt ? <Row key={token.fingerprint} title={token.label} meta={line} end={state} />
                  : <AskRow key={token.fingerprint} title={token.label} meta={line} end={state}
                      asks={{ busy, label: `Revoke token ${token.label}`, ask: 'Revoke token…', yes: 'Revoke it', no: 'Keep it', act: () => change('token.revoke', { fingerprint: token.fingerprint }, 'revokeToken'),
                        children: 'Revoke this token? Whatever uses it stops working, and it cannot be restored.' }} />;
              })}
            </Rows>
          )}
        </Section>
      )}
      {primary && (
        <Section title="Signed-in browsers" count={setup.sessions.length || undefined}>
          {!setup.sessions.length ? <Note>No browsers</Note> : (
            <Rows>
              {setup.sessions.map((session) => (
                <AskRow key={session.ref} title={session.device} meta={<>{sessionLine(session)} · Last used <Time at={session.seenAt} /></>}
                  asks={{ busy, label: `Sign out ${session.device}`, ask: 'Sign out browser…', yes: 'Sign it out', no: 'Keep it', act: () => change('sessions.revoke', { ref: session.ref }, 'revokeSession'),
                    children: 'Sign this browser out? It must sign in again.' }} />
              ))}
            </Rows>
          )}
        </Section>
      )}
      {programs && (
        <Section title="Outside program grants">
          {!programs.tokens.length ? <Note>No outside program tokens yet.</Note>
            : <Rows>{programs.tokens.map((token) => <Grants key={JSON.stringify(token)} token={token} catalogue={programs.catalogue} busy={busy} save={(input) => void change('program.setGrants', input, 'setGrants')} />)}</Rows>}
          <Note>{programNote}</Note>
        </Section>
      )}
      {primary && (
        <>
          <Note>To add or change a member, an agent’s description, badge, face or GitHub accounts, or to restore a removed agent, ask the agent in the conversation: it proposes the change and you answer it in the Inbox.</Note>
          <Note>A new token is made on the desktop, where its value is shown once. An agent’s animated portrait is changed there too.</Note>
        </>
      )}
    </>
  );
}
