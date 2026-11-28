/** The `secrets` brick: the household's secrets as the desktop's Settings shows them, for a household owner, from
 * Settings' one selection (pieces/settings/data.ts). The server answers `secretsReader` for an owner only, and for
 * anyone else this draws its unavailable line and nothing more. Every change is Settings' own call
 * (pieces/settings/commands.ts): `secrets.command` to allow, deny or cancel a request and to revoke a grant,
 * `secrets.remove` to remove a secret (asked first), `secrets.set` for a value.
 *
 * A VALUE. It is typed into one uncontrolled password field and leaves the browser exactly once, through the
 * desktop's `submitSecret`, which empties the field before the request is made. It is never in React state, never
 * a property of this brick, never passed to `act`, and no reply's words are shown: a change is "Saved." or "not
 * confirmed" (pieces/settings/words.ts). A description is never told either.
 *
 * WHAT THE BOARD IS TOLD. Once loom acknowledged a value set or a secret removed, the board is told the secret's
 * NAME and what happened, `added`, `replaced` or `removed` (the owner's ruling, 2026-11-27: the agent knows a key
 * was saved under that name and never sees the key). An answer, a cancel or a revoke is told with nothing. A change
 * that was refused or not confirmed tells the board nothing: the member reads "not confirmed" here, and that is all.
 *
 * Not here: the household default and a secret's standing rule cannot be changed by a member's own operation, on
 * the desktop either. Settings drafts a message asking an agent to propose the change, and the owner answers that
 * proposal. Here the member asks the agent in the conversation beside the board, and this brick says so. */
import { useRef, useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { newId } from '../data/id';
import { settingsCommand, submitSecret } from '../pieces/settings/commands';
import { settingsQuery, settingsSnapshot, type SettingsData } from '../pieces/settings/data';
import { ANSWER_WORDS, USE_WORDS, WRITE_ONLY_WORDS, resultText } from '../pieces/settings/words';
import { Action, Actions, Asking, Chip, Fact, Facts, Few, Lead, Loading, More, Note, Row, Rows, Section, State, Time, Unavailable, useOwnFlag, useSettling, type BodyProps, type Tone } from './brick-kit';

const agentRef = /^[A-Za-z0-9][A-Za-z0-9:._\/@-]{0,119}$/;
/** An agent as a chip that places its brick, or its id alone when the id is not one a board can hold. */
const agentChip = (id: string) => (agentRef.test(id) ? <Chip place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip> : <span>{id}</span>);
const count = (n: number, one: string, many = one + 's') => `${n || 'No'} ${n === 1 ? one : many}`;
const requestTone = (state: string): Tone => (state === 'allowed' ? 'good' : state === 'denied' ? 'bad' : state === 'pending' ? 'waiting' : 'muted');
const ASK_AGENT = 'To change this default or a secret\'s standing rule, ask your agent in this conversation to propose it. Its proposal comes to you as an approval to answer.';
type Detail = Record<string, string>;
type Run = (action: string, work: () => Promise<boolean>, detail?: Detail) => void;
/** The secrets store's name shape (secretName, src/pieces/secrets/input.ts), and the shape the board's detail takes. */
const secretName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function Secrets({ form, act, raise }: BodyProps) {
  const snapshot = settingsSnapshot(useDataQuery<SettingsData>(settingsQuery, undefined, { keep: true }));
  const live = snapshot.status === 'live';
  const waiting = snapshot.requests.filter((request) => request.state === 'pending');
  useOwnFlag(live ? waiting.length : undefined, raise, (was, now) => (now > was ? 'New request' : null));
  // Nothing is answered, changed or removed from what the page only remembers: every control waits for the fresh reading.
  const stale = useSettling();
  const [saving, setBusy] = useState(false), busy = saving || stale, [message, setMessage] = useState(''), [open, setOpen] = useState<string>(), [always, setAlways] = useState<string[]>([]);
  const lock = useRef(false);
  if (snapshot.status === 'loading') return <Loading />;
  if (!live) return <Unavailable what="list of secrets" />;
  const counts = `${count(snapshot.secrets.length, 'secret')} · ${waiting.length ? `${waiting.length} request${waiting.length === 1 ? '' : 's'} waiting` : 'no request waiting'}`;
  if (form === 'compact') return <p className="board-brief">{counts}</p>;
  if (form === 'side') return (
    <>
      <Lead>{counts} · {count(snapshot.grants.length, 'grant')}</Lead>
      {/* The side form says what waits on the member; the secrets themselves are named in the big form. */}
      {waiting.length > 0 ? <Few of={waiting} first={3}>{(shown, hidden) => <>
        <Rows>{shown.map((request) => <Row key={request.id} flagged title={<>{agentChip(request.agent)} asks for <span className="font-mono">{request.secret}</span></>} />)}</Rows>
        <More n={hidden} words="more waiting" />
      </>}</Few> : <Note>No request is waiting.</Note>}
    </>
  );
  /** One change at a time. `work` starts in the same turn as the press, so a value's field is emptied at once. The
   * board is told only when the change was acknowledged, with `detail` (a secret's name and outcome, or nothing). */
  const run: Run = (action, work, detail = {}) => {
    if (lock.current || stale) return;
    lock.current = true; setBusy(true); setMessage('');
    void work().catch(() => false).then((saved) => {
      lock.current = false; setBusy(false); setMessage(resultText(saved));
      if (saved) { setOpen(undefined); act(action, detail); }
    });
  };
  const answer = (id: string, allow: boolean) => run(allow ? 'allow' : 'deny', () => settingsCommand('command', { action: 'answer', id, allow, always: always.includes(id) }));
  const answered = snapshot.requests.filter((request) => request.state !== 'pending').slice(0, 10);
  return (
    <>
      <Lead>{counts} · {count(snapshot.grants.length, 'grant')}</Lead>
      <p role="status" className="board-note">{saving ? 'Saving…' : message}</p>

      <Section title="Requests waiting" count={waiting.length || undefined}>
        {!waiting.length ? <Note>No request is waiting.</Note> : (
          <Rows>
            {waiting.map((request) => (
              <Row key={request.id} title={<>{agentChip(request.agent)} asks for <span className="font-mono">{request.secret}</span></>} end={<span>{request.minutes} minutes</span>}
                meta={<>{request.why}<br />Asked <Time at={request.askedAt} />{request.job ? ` · Job: ${request.job}` : ''}</>}>
                <label className="board-check">
                  <input type="checkbox" aria-label={`Always answer this way for ${request.agent}: ${request.secret}`} checked={always.includes(request.id)} disabled={busy}
                    onChange={(e) => setAlways((now) => (e.target.checked ? [...now, request.id] : now.filter((id) => id !== request.id)))} />
                  <span>Always answer this way for this agent</span>
                </label>
                <Actions>
                  <Action disabled={busy} label={`Allow ${request.agent}: ${request.secret}`} onClick={() => answer(request.id, true)}>Allow</Action>
                  <Action disabled={busy} label={`Deny ${request.agent}: ${request.secret}`} onClick={() => answer(request.id, false)}>Deny</Action>
                  <Action kind="quiet" disabled={busy} label={`Cancel request ${request.agent}: ${request.secret}`} onClick={() => run('cancel', () => settingsCommand('command', { action: 'cancel', id: request.id }))}>Cancel request</Action>
                </Actions>
              </Row>
            ))}
          </Rows>
        )}
      </Section>

      <Section title="Secrets" count={snapshot.secrets.length || undefined}>
        {!snapshot.secrets.length && <Note>No secrets.</Note>}
        <Rows>
          {snapshot.secrets.map((secret) => {
            const rule = snapshot.rules.find((row) => row.secret === secret.name), agents = snapshot.ruleAgents.filter((row) => row.secret === secret.name);
            const grants = snapshot.grants.filter((row) => row.secret === secret.name), uses = snapshot.uses.filter((row) => row.secret === secret.name);
            return (
              <Row key={secret.name} title={<span className="font-mono">{secret.name}</span>} meta={secret.description || undefined}
                end={<>
                  <Action kind="quiet" disabled={busy} label={`Replace the value of ${secret.name}`} onClick={() => setOpen('value:' + secret.name)}>Replace value…</Action>
                  <Action kind="quiet" disabled={busy} label={`Remove ${secret.name}`} onClick={() => setOpen('remove:' + secret.name)}>Remove…</Action>
                </>}>
                <Note>Changed <Time at={secret.changedAt} /> by {secret.changedBy} · {rule ? `Standing answer: ${ANSWER_WORDS[rule.answer] ?? rule.answer} · Automatic grant: ${rule.minutes} minutes` : 'No rule of its own: the household default applies.'}</Note>
                {agents.length > 0 && <div className="board-meta">{agents.map((row) => <span key={row.agent + row.when}>{agentChip(row.agent)} {row.when === 'at_start' ? 'At startup' : 'When asked'}</span>)}</div>}
                {grants.map((grant) => (
                  <div key={grant.id} className="board-secrets-grant">
                    <span>{agentChip(grant.agent)} may use it · {grant.job ? `Job: ${grant.job}` : 'Agent-wide'} · Expires <Time at={grant.expiresAt} /> · Granted by {grant.grantedBy}</span>
                    <Action kind="quiet" disabled={busy} label={`Revoke ${grant.agent}'s grant of ${secret.name}`} onClick={() => run('revoke', () => settingsCommand('command', { action: 'revoke', id: grant.id }))}>Revoke grant</Action>
                  </div>
                ))}
                {uses.length > 0 && <Note>{uses.slice(0, 3).map((use, index) => <span key={use.id}>{index > 0 && <br />}Used <Time at={use.at} /> · {use.agent} · {USE_WORDS[use.state] ?? use.state}</span>)}</Note>}
                {open === 'value:' + secret.name && <ValueForm name={secret.name} description={secret.description} busy={busy} run={run} cancel={() => setOpen(undefined)} />}
                {open === 'remove:' + secret.name && (
                  <Asking label="Remove this secret?" yes="Remove value and revoke access" no="Keep" disabled={busy}
                    onYes={() => run('remove', () => settingsCommand('remove', { id: newId(), name: secret.name }), { secret: secret.name, outcome: 'removed' })} onNo={() => setOpen(undefined)}>Remove this secret's value and revoke every access to it? It cannot be brought back.</Asking>
                )}
              </Row>
            );
          })}
        </Rows>
        {open === 'add'
          ? <ValueForm busy={busy} run={run} cancel={() => setOpen(undefined)} />
          : <Actions><Action disabled={busy} onClick={() => setOpen('add')}>Add a secret…</Action></Actions>}
      </Section>

      <Section title="Household default">
        <Facts><Fact label="For a secret with no rule">{snapshot.defaultAnswer ? ANSWER_WORDS[snapshot.defaultAnswer] ?? snapshot.defaultAnswer : 'not loaded'}.</Fact></Facts>
        <Note>{ASK_AGENT}</Note>
      </Section>

      {answered.length > 0 && (
        <Section title="Earlier requests">
          <Rows>
            {answered.map((request) => <Row key={request.id} title={<>{agentChip(request.agent)} <span className="font-mono">{request.secret}</span></>} end={<State tone={requestTone(request.state)}>{request.state}</State>}
              meta={request.always ? 'A standing rule was made with this answer.' : undefined} />)}
          </Rows>
        </Section>
      )}
    </>
  );
}

/** Settings' write-only form. Every field is uncontrolled: nothing typed here is in React state. On submit the
 * value field itself is handed to `submitSecret`, which reads it, empties it and sends it, in that order. A name the
 * store would refuse is not sent: nothing leaves, and the field keeps what was typed. */
function ValueForm({ name, description = '', busy, run, cancel }: { name?: string; description?: string; busy: boolean; run: Run; cancel(): void }) {
  const value = useRef<HTMLInputElement>(null), named = useRef<HTMLInputElement>(null), about = useRef<HTMLInputElement>(null);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const field = value.current, secret = name ?? named.current?.value ?? '';
    if (busy || !field || !field.value || !secretName.test(secret)) return;
    run('setValue', () => submitSecret({ name: secret, description: about.current?.value ?? '', mode: name ? 'replace' : 'add', field }), { secret, outcome: name ? 'replaced' : 'added' });
  };
  return (
    <form className="board-form" aria-label={name ? `Replace ${name}` : 'Add a secret'} autoComplete="off" onSubmit={save}>
      {!name && <label className="board-field"><span>Name</span><input ref={named} className="board-input font-mono" aria-label="Name" required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}" autoComplete="off" /></label>}
      <label className="board-field"><span>Description</span><input ref={about} className="board-input" aria-label="Description" defaultValue={description} maxLength={4000} autoComplete="off" /></label>
      <label className="board-field"><span>Value</span><input ref={value} className="board-input" aria-label="Value" type="password" required autoComplete="new-password" spellCheck={false} /></label>
      <Note>{WRITE_ONLY_WORDS}</Note>
      <Actions>
        <Action submit kind="primary" disabled={busy}>{busy ? 'Saving…' : name ? 'Save replacement' : 'Add secret'}</Action>
        <Action kind="quiet" disabled={busy} onClick={cancel}>Cancel</Action>
      </Actions>
    </form>
  );
}
