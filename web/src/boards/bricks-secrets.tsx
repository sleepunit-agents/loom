/** The `secrets` brick: the household's secrets as the desktop's Settings shows them, for a household owner, from
 * Settings' one selection (pieces/settings/data.ts). The server answers `secretsReader` for an owner only, and for
 * anyone else this draws its unavailable line and nothing more. Every change is Settings' own call
 * (pieces/settings/commands.ts): `secrets.command` to allow, deny or cancel a request and to revoke a grant,
 * `secrets.remove` to remove a secret (asked first), `secrets.set` for a value.
 *
 * A VALUE. It is typed into one uncontrolled password field and leaves the browser exactly once, through the
 * desktop's `submitSecret`, which empties the field before the request is made. It is never in React state, never
 * a property of this brick, never passed to `act`, and no reply's words are shown: a change is "Saved." or "not
 * confirmed" (pieces/settings/words.ts). The board is told that an action happened and nothing else, not even the
 * secret's name.
 *
 * Not here: the household default and a secret's standing rule cannot be changed by a member's own operation, on
 * the desktop either. Settings drafts a message asking an agent to propose the change, and the owner answers that
 * proposal. Here the member asks the agent in the conversation beside the board, and this brick says so. */
import { useRef, useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { newId } from '../data/id';
import { useHouseholdZone } from '../data/zone';
import { fullTime } from '../kit/time';
import { settingsCommand, submitSecret } from '../pieces/settings/commands';
import { settingsQuery, settingsSnapshot, type SettingsData } from '../pieces/settings/data';
import { ANSWER_WORDS, USE_WORDS, WRITE_ONLY_WORDS, resultText } from '../pieces/settings/words';
import { Chip, Loading, Unavailable, useOwnFlag, type BodyProps } from './brick-kit';

const agentRef = /^[A-Za-z0-9][A-Za-z0-9:._\/@-]{0,119}$/;
/** An agent as a chip that places its brick, or its id alone when the id is not one a board can hold. */
const agentChip = (id: string) => (agentRef.test(id) ? <Chip place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip> : <span>{id}</span>);
const count = (n: number, one: string, many = one + 's') => `${n || 'No'} ${n === 1 ? one : many}`;
const ASK_AGENT = 'To change this default or a secret\'s standing rule, ask your agent in this conversation to propose it. Its proposal comes to you as an approval to answer.';
type Run = (action: string, work: () => Promise<boolean>) => void;

export function Secrets({ form, act, raise }: BodyProps) {
  const zone = useHouseholdZone();
  const snapshot = settingsSnapshot(useDataQuery<SettingsData>(settingsQuery, undefined, { keep: true }));
  const live = snapshot.status === 'live';
  const waiting = snapshot.requests.filter((request) => request.state === 'pending');
  useOwnFlag(live ? waiting.length : undefined, raise, (was, now) => (now > was ? 'New request' : null));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [open, setOpen] = useState<string>(), [always, setAlways] = useState<string[]>([]);
  const lock = useRef(false);
  if (snapshot.status === 'loading') return <Loading />;
  if (!live) return <Unavailable what="list of secrets" />;
  const counts = `${count(snapshot.secrets.length, 'secret')} · ${waiting.length ? `${waiting.length} request${waiting.length === 1 ? '' : 's'} waiting` : 'no request waiting'}`;
  if (form === 'compact') return <p className="board-brief">{counts}</p>;
  if (form === 'side') return (
    <>
      <p className="board-lead">{counts} · {count(snapshot.grants.length, 'grant')}</p>
      {waiting.slice(0, 4).map((request) => <p key={request.id} className="board-line">{agentChip(request.agent)}<span>asks for</span><span className="font-mono">{request.secret}</span></p>)}
      <p className="text-muted-foreground" style={{ overflowWrap: 'anywhere' }}>{snapshot.secrets.slice(0, 8).map((secret) => secret.name).join(', ')}{snapshot.secrets.length > 8 ? ' and more' : ''}</p>
    </>
  );
  /** One change at a time. `work` starts in the same turn as the press, so a value's field is emptied at once. The
   * board is told only when the change was acknowledged. */
  const run: Run = (action, work) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    void work().catch(() => false).then((saved) => {
      lock.current = false; setBusy(false); setMessage(resultText(saved));
      if (saved) { setOpen(undefined); act(action, {}); }
    });
  };
  const answer = (id: string, allow: boolean) => run(allow ? 'allow' : 'deny', () => settingsCommand('command', { action: 'answer', id, allow, always: always.includes(id) }));
  const answered = snapshot.requests.filter((request) => request.state !== 'pending').slice(0, 10);
  return (
    <>
      <p className="board-lead">{counts} · {count(snapshot.grants.length, 'grant')}</p>
      <p role="status">{busy ? 'Saving…' : message}</p>
      <p>For a secret with no rule: {snapshot.defaultAnswer ? ANSWER_WORDS[snapshot.defaultAnswer] ?? snapshot.defaultAnswer : 'not loaded'}.</p>
      <p className="text-muted-foreground">{ASK_AGENT}</p>

      <h4>Requests waiting</h4>
      {!waiting.length && <p className="text-muted-foreground">No request is waiting.</p>}
      <ul className="board-notes">
        {waiting.map((request) => (
          <li key={request.id}>
            <span className="board-line" style={{ marginTop: 0 }}>{agentChip(request.agent)}<span>asks for</span><span className="font-mono">{request.secret}</span><span className="board-state">{request.minutes} minutes</span></span>
            <p>{request.why}</p>
            <small>Asked {fullTime(request.askedAt, zone)}{request.job ? ` · Job: ${request.job}` : ''}</small>
            <label className="board-line">
              <input type="checkbox" aria-label={`Always answer this way for ${request.agent}: ${request.secret}`} checked={always.includes(request.id)} disabled={busy}
                onChange={(e) => setAlways((now) => (e.target.checked ? [...now, request.id] : now.filter((id) => id !== request.id)))} />
              <span>Always answer this way for this agent</span>
            </label>
            <span className="board-line">
              <button type="button" className="board-action" disabled={busy} aria-label={`Allow ${request.agent}: ${request.secret}`} onClick={() => answer(request.id, true)}>Allow</button>
              <button type="button" className="board-action" disabled={busy} aria-label={`Deny ${request.agent}: ${request.secret}`} onClick={() => answer(request.id, false)}>Deny</button>
              <button type="button" className="board-action" disabled={busy} aria-label={`Cancel request ${request.agent}: ${request.secret}`} onClick={() => run('cancel', () => settingsCommand('command', { action: 'cancel', id: request.id }))}>Cancel request</button>
            </span>
          </li>
        ))}
      </ul>

      <h4>Secrets</h4>
      {!snapshot.secrets.length && <p className="text-muted-foreground">No secrets.</p>}
      <ul className="board-notes">
        {snapshot.secrets.map((secret) => {
          const rule = snapshot.rules.find((row) => row.secret === secret.name), agents = snapshot.ruleAgents.filter((row) => row.secret === secret.name);
          const grants = snapshot.grants.filter((row) => row.secret === secret.name), uses = snapshot.uses.filter((row) => row.secret === secret.name);
          return (
            <li key={secret.name}>
              <span className="board-line" style={{ marginTop: 0 }}>
                <span className="font-mono">{secret.name}</span>
                <button type="button" className="board-action" disabled={busy} aria-label={`Replace the value of ${secret.name}`} onClick={() => setOpen('value:' + secret.name)}>Replace value…</button>
                <button type="button" className="board-action" disabled={busy} aria-label={`Remove ${secret.name}`} onClick={() => setOpen('remove:' + secret.name)}>Remove…</button>
              </span>
              {secret.description && <p>{secret.description}</p>}
              <small>Changed {fullTime(secret.changedAt, zone)} by {secret.changedBy}</small>
              <small>{rule ? `Standing answer: ${ANSWER_WORDS[rule.answer] ?? rule.answer} · Automatic grant: ${rule.minutes} minutes` : 'No rule of its own: the household default applies.'}</small>
              {agents.map((row) => <span key={row.agent + row.when} className="board-line">{agentChip(row.agent)}<span>{row.when === 'at_start' ? 'At startup' : 'When asked'}</span></span>)}
              {grants.map((grant) => (
                <span key={grant.id} className="board-line">
                  {agentChip(grant.agent)}<span>may use it · {grant.job ? `Job: ${grant.job}` : 'Agent-wide'} · Expires {fullTime(grant.expiresAt, zone)} · Granted by {grant.grantedBy}</span>
                  <button type="button" className="board-action" disabled={busy} aria-label={`Revoke ${grant.agent}'s grant of ${secret.name}`} onClick={() => run('revoke', () => settingsCommand('command', { action: 'revoke', id: grant.id }))}>Revoke grant</button>
                </span>
              ))}
              {uses.slice(0, 3).map((use) => <small key={use.id}>Used {fullTime(use.at, zone)} · {use.agent} · {USE_WORDS[use.state] ?? use.state}</small>)}
              {open === 'value:' + secret.name && <ValueForm name={secret.name} description={secret.description} busy={busy} run={run} cancel={() => setOpen(undefined)} />}
              {open === 'remove:' + secret.name && (
                <span className="board-line" role="group" aria-label="Remove this secret?">
                  <span>Remove this secret's value and revoke every access to it? It cannot be brought back.</span>
                  <button type="button" className="board-action" disabled={busy} onClick={() => run('remove', () => settingsCommand('remove', { id: newId(), name: secret.name }))}>Remove value and revoke access</button>
                  <button type="button" className="board-action" disabled={busy} onClick={() => setOpen(undefined)}>Keep</button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {open === 'add'
        ? <ValueForm busy={busy} run={run} cancel={() => setOpen(undefined)} />
        : <button type="button" className="board-action" disabled={busy} onClick={() => setOpen('add')}>Add a secret…</button>}

      {answered.length > 0 && <h4>Earlier requests</h4>}
      {answered.map((request) => <p key={request.id} className="board-line">{agentChip(request.agent)}<span className="font-mono">{request.secret}</span><span className="board-state">{request.state}</span>{request.always && <span>A standing rule was made with this answer.</span>}</p>)}
    </>
  );
}

/** Settings' write-only form. Every field is uncontrolled: nothing typed here is in React state. On submit the
 * value field itself is handed to `submitSecret`, which reads it, empties it and sends it, in that order. */
function ValueForm({ name, description = '', busy, run, cancel }: { name?: string; description?: string; busy: boolean; run: Run; cancel(): void }) {
  const value = useRef<HTMLInputElement>(null), named = useRef<HTMLInputElement>(null), about = useRef<HTMLInputElement>(null);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const field = value.current, secret = name ?? named.current?.value ?? '';
    if (busy || !field || !field.value || !secret) return;
    run('setValue', () => submitSecret({ name: secret, description: about.current?.value ?? '', mode: name ? 'replace' : 'add', field }));
  };
  return (
    <form aria-label={name ? `Replace ${name}` : 'Add a secret'} autoComplete="off" onSubmit={save}>
      <p className="text-muted-foreground">{WRITE_ONLY_WORDS}</p>
      {!name && <label className="board-line"><span>Name</span><input ref={named} className="board-input" aria-label="Name" required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}" autoComplete="off" /></label>}
      <label className="board-line"><span>Description</span><input ref={about} className="board-input" aria-label="Description" defaultValue={description} maxLength={4000} autoComplete="off" /></label>
      <label className="board-line"><span>Value</span><input ref={value} className="board-input" aria-label="Value" type="password" required autoComplete="new-password" spellCheck={false} /></label>
      <span className="board-line">
        <button type="submit" className="board-action" disabled={busy}>{busy ? 'Saving…' : name ? 'Save replacement' : 'Add secret'}</button>
        <button type="button" className="board-action" disabled={busy} onClick={cancel}>Cancel</button>
      </span>
    </form>
  );
}
