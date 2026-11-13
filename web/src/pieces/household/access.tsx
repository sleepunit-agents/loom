import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { call, callOnce, useRecords, type Call, type LiveRecord } from '../../data';
import { Button, Input, Empty, Error, Loading } from '../../kit';
import { frozen, idle, mutation, tokenAttempt, type Household } from './model';
interface Token { ref: string; label: string; role: string; member?: string; created: string; expires?: string; revoked?: string; last_used?: string; passkey: boolean; from?: string }
interface Session { ref: string; issuedAt: number; expiresAt: number; seenAt?: number; device?: string; label?: string; via?: string; agent: boolean; token?: string; member?: string; ended: boolean }
interface Admin extends LiveRecord { tokens: Token[]; sessions: Session[]; at: number }
const noop = () => () => {};
const when = (value?: string | number) => value === undefined ? 'Not recorded' : new Date(value).toLocaleString('en-US', { timeZone: 'America/Chicago' }) + ' CT';
export function tokenInput(data: FormData) {
  const role = String(data.get('role'));
  const expires = String(data.get('expires') ?? '').trim();
  return { label: String(data.get('label') ?? ''), role,
    ...(role === 'owner' ? { member: String(data.get('member') ?? '') } : role === 'agent' ? { agent: String(data.get('agent') ?? '') } : { principal: String(data.get('principal') ?? '') }),
    ...(expires ? { expires } : {}) };
}
export default function AccessAdmin({ active = true, firstAgent }: { active?: boolean; firstAgent?: string }) {
  const feed = useRecords<Admin>('signin.admin'), household = useRecords<Household>('household.sharing');
  const held = useSyncExternalStore(mutation.subscribe, mutation.getSnapshot);
  const change = useSyncExternalStore(held.request?.subscribe ?? noop, held.request?.getSnapshot ?? (() => idle));
  const [mint, setMint] = useState<Call<{ token: string }> | undefined>();
  const result = useSyncExternalStore(mint?.subscribe ?? noop, mint?.getSnapshot ?? (() => idle));
  const attempted = useSyncExternalStore(tokenAttempt.subscribe, tokenAttempt.getSnapshot);
  const [role, setRole] = useState('owner');
  useEffect(() => { if (firstAgent) setRole('agent'); }, [firstAgent]);
  const admin = feed.records[0], h = household.records[0];
  // Never retain a returned bearer beyond this mounted, authorized, connected screen.
  useEffect(() => { if (feed.status !== 'live' || !active || !admin || !h) setMint(undefined); }, [feed.status, active, admin, h]);
  useEffect(() => { if (result.result && (result.result.ok || result.result.code !== 'unavailable')) tokenAttempt.set(undefined); }, [result.result]);
  const live = active && feed.status === 'live' && household.status === 'live' && !!admin && !!h;
  const enabled = live && !frozen(change) && !result.pending;
  const revoke = (name: string, input: unknown, title: string) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enabled || frozen(mutation.getSnapshot().request?.getSnapshot() ?? idle)) return;
    mutation.set(call(name, input), title);
    event.currentTarget.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(input => { input.checked = false; });
  };
  if (feed.status === 'denied') return <Error text="Credential administration is only available to household owners." />;
  if (feed.status === 'loading') return <Loading label="Opening tokens and sessions…" />;
  if (!admin || !h) return <Empty title="Tokens and sessions unavailable" />;
  return <section aria-label="Tokens and sessions" className="grid min-w-0 gap-4">
    <h2 className="text-xl font-semibold">Tokens and sessions</h2>
    {!live && <Error text="Connection lost. Credential changes are disabled." />}
    <p>Tokens grant the named identity’s current access. Revoking a token ends its sign-ins. Revoking a session signs out that browser only.</p>
    <form aria-label="Create token" className="grid min-w-0 gap-3 rounded-xl border p-4" onSubmit={event => {
      event.preventDefault();
      if (!enabled || frozen(mutation.getSnapshot().request?.getSnapshot() ?? idle) || mint?.getSnapshot().pending) return;
      const input = tokenInput(new FormData(event.currentTarget));
      tokenAttempt.set(input.label);
      setMint(callOnce<{ token: string }>('token.create', input));
    }}><fieldset disabled={!enabled} className="grid min-w-0 gap-3">
      <legend className="font-semibold">Create token</legend>
      <label className="grid gap-1">Token label<Input key={firstAgent} name="label" required maxLength={120} defaultValue={firstAgent ? `${firstAgent} · first token` : undefined} /></label>
      <label className="grid gap-1">Identity<select name="role" value={role} onChange={event => setRole(event.target.value)}><option value="owner">Household member</option><option value="agent">Agent</option><option value="runner">Active runner</option><option value="service">Active service</option></select></label>
      {role === 'owner' ? <label className="grid gap-1">Member<select name="member">{h.members.map(person => <option key={person}>{person}</option>)}</select></label> : role === 'agent' ? <label className="grid gap-1">Agent<select key={firstAgent} name="agent" defaultValue={firstAgent}>{h.agents.map(agent => <option key={agent}>{agent}</option>)}</select></label> : <label className="grid gap-1">Active principal<Input name="principal" required /><span className="text-sm text-muted-foreground">Exact name of an already active {role}. Creating a token does not activate it or grant access.</span></label>}
      <label className="grid gap-1">Expires (optional)<Input name="expires" placeholder="2027-01-01T00:00:00Z" /><span className="text-sm text-muted-foreground">ISO timestamp with timezone; leave empty for no expiry.</span></label>
      <Button type="submit" variant="outline">Create token</Button>
    </fieldset></form>
    {attempted && !result.pending && <p role="status">A token creation for “{attempted}” may have completed. It will not be retried. Check the token list and revoke that label before creating a replacement.</p>}
    {live && mint && <section aria-label="New token" aria-live="polite" className="grid min-w-0 gap-2 rounded-xl border p-4">
      {result.pending ? <Loading label="Creating token…" /> : result.result?.ok ? <><p>Save this token now. It is shown only in this window until you hide it, leave Setup or lose the connection.</p><code className="break-all select-all" aria-label="Token value">{(result.result.value as { token: string }).token}</code><Button variant="outline" onClick={() => setMint(undefined)}>Hide token</Button></> : result.result && <><Error text={result.result.message} />{result.result.code === 'unavailable' && <p>The token may have been created. It will not be retried. Check the token list and revoke that label before creating a replacement.</p>}</>}
    </section>}
    <h3 className="font-semibold">Tokens</h3>
    {!admin.tokens.length && <Empty title="No tokens" />}
    <ul className="grid min-w-0 gap-3">{admin.tokens.map((token, index) => <li key={`${token.label}:${token.created}:${index}`} className="grid min-w-0 gap-2 rounded-xl border p-4 break-words">
      <p className="font-semibold">{token.label}</p><p>{token.role}{token.member ? ` · ${token.member}` : ''}{token.passkey ? ' · passkey' : ''}{token.revoked ? ' · revoked' : ''}</p>
      <p>Created: {when(token.created)}<br />Last used: {when(token.last_used)}<br />Expires: {token.expires ? when(token.expires) : 'Never'}{token.from && <><br />From: {token.from}</>}</p>
      {!token.revoked && (!token.expires || Date.parse(token.expires) > admin.at) && <form aria-label={`Revoke token ${token.label}`} onSubmit={event => {
        const data = new FormData(event.currentTarget);
        revoke('token.revoke', { label: token.label, ref: token.ref, withPasskeys: data.has('passkeys'), withDevices: data.has('devices') }, `Revoke token ${token.label}`)(event);
      }}><fieldset disabled={!enabled} className="grid gap-2"><label className="flex gap-2"><input name="passkeys" type="checkbox" />Also revoke descendant passkeys</label><label className="flex gap-2"><input name="devices" type="checkbox" />Also remove push devices</label><label className="flex gap-2"><input type="checkbox" required />I confirm revoking {token.label}</label><Button type="submit" variant="outline">Revoke token</Button></fieldset></form>}
    </li>)}</ul>
    <h3 className="font-semibold">Sessions</h3>
    {!admin.sessions.length && <Empty title="No sessions" />}
    <ul className="grid min-w-0 gap-3">{admin.sessions.map(session => <li key={session.ref} className="grid min-w-0 gap-2 rounded-xl border p-4 break-words">
      <p className="font-semibold">{session.label ?? session.device ?? session.ref}</p><p>Session: <code>{session.ref}</code></p><p>{session.member ?? 'Unknown member'} · {session.agent ? 'Agent browser' : 'Browser'} · {session.ended ? 'Ended' : 'Active'}{session.via ? ` · ${session.via}` : ''}</p>
      <p>Token: {session.token ?? 'Unknown'}<br />Created: {when(session.issuedAt * 1000)}<br />Last seen: {when(session.seenAt === undefined ? undefined : session.seenAt * 1000)}<br />Expires: {when(session.expiresAt)}</p>
      <form aria-label={`Revoke session ${session.ref}`} onSubmit={revoke('sessions.revoke', { ref: session.ref }, 'Revoke session')}><fieldset disabled={!enabled} className="grid gap-2"><label className="flex gap-2"><input type="checkbox" required />I confirm signing out session {session.ref}</label><Button type="submit" variant="outline">Revoke session</Button></fieldset></form>
    </li>)}</ul>
  </section>;
}
