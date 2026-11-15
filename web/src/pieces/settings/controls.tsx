import { useRef, useState, type FormEvent } from 'react';
import { Button, Input } from '../../kit';
import { newId } from '../../data/id';
import type { SecretsSnapshot } from '../secrets-view';
import { settingsCommand, submitSecret } from './commands';
const resultText = (saved: boolean) => saved ? 'Saved.' : 'Change not confirmed. Check the current item before starting a new change.';
function useCommand() {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const current = useRef(false);
  return { busy, message, async run(action: () => Promise<boolean>) {
    if (current.current) return;
    current.current = true; setBusy(true); setMessage('');
    try { setMessage(resultText(await action())); } catch { setMessage(resultText(false)); } finally { current.current = false; setBusy(false); }
  } };
}
export function ValueControl({ name, description = '' }: { name?: string; description?: string }) {
  const value = useRef<HTMLInputElement>(null), command = useCommand();
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (command.busy || !value.current) return;
    const data = new FormData(event.currentTarget), field = value.current;
    void command.run(() => submitSecret({ name: name ?? String(data.get('name')), description: String(data.get('description')), mode: name ? 'replace' : 'add', field }));
  };
  return <form onSubmit={save} className="grid gap-3">
    {name ? <h2>Replace {name}</h2> : <label>Name<Input name="name" required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" autoComplete="off" /></label>}
    <label>Description<Input name="description" defaultValue={description} maxLength={4000} /></label>
    <label>Value<Input ref={value} type="password" required autoComplete="new-password" spellCheck={false} /></label>
    <Button type="submit" disabled={command.busy}>{command.busy ? 'Saving…' : name ? 'Save replacement' : 'Add secret'}</Button>
    {name && <Button type="button" disabled={command.busy} onClick={() => { if (value.current) value.current.value = ''; void command.run(() => settingsCommand('remove', { id: newId(), name })); }}>Remove value and revoke access</Button>}
    <p role="status">{command.message}</p>
  </form>;
}
export function RequestControl({ id }: { id: string }) {
  const command = useCommand(), [always, setAlways] = useState(false);
  return <section className="grid gap-3"><label><input type="checkbox" checked={always} onChange={e => setAlways(e.target.checked)} />Always answer this way for this agent</label>
    <Button disabled={command.busy} onClick={() => { void command.run(() => settingsCommand('command', { action: 'answer', id, allow: true, always })); }}>Allow</Button>
    <Button disabled={command.busy} onClick={() => { void command.run(() => settingsCommand('command', { action: 'answer', id, allow: false, always })); }}>Deny</Button>
    <Button disabled={command.busy} onClick={() => { void command.run(() => settingsCommand('command', { action: 'cancel', id })); }}>Cancel request</Button><p role="status">{command.message}</p>
  </section>;
}
export function RevokeControl({ id }: { id: string }) {
  const command = useCommand();
  return <section><Button disabled={command.busy} onClick={() => { void command.run(() => settingsCommand('command', { action: 'revoke', id })); }}>Revoke grant</Button><p role="status">{command.message}</p></section>;
}
const choices = <><option value="ask">Ask each time</option><option value="auto">Allow automatically</option><option value="never">Never allow</option></>;
export function DefaultControl({ answer }: { answer: 'ask' | 'auto' | 'never' }) {
  const command = useCommand();
  return <form className="grid gap-3" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void command.run(() => settingsCommand('command', { action: 'default', answer: data.get('answer') })); }}>
    <label>For a secret with no rule<select name="answer" defaultValue={answer}>{choices}</select></label><Button type="submit" disabled={command.busy}>Save household default</Button><p role="status">{command.message}</p>
  </form>;
}
export function RuleControl({ secret, snapshot }: { secret: string; snapshot: SecretsSnapshot }) {
  const command = useCommand(), rule = snapshot.rules.find(row => row.secret === secret), assignments = snapshot.ruleAgents.filter(row => row.secret === secret);
  return <form className="grid gap-3" onSubmit={event => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const agents = (when: 'on_request' | 'at_start') => String(data.get(when) ?? '').split(',').map(agent => agent.trim()).filter(Boolean).map(agent => ({ agent, when }));
    void command.run(() => settingsCommand('command', { action: 'rule', secret, answer: data.get('answer'), minutes: Number(data.get('minutes')), agents: [...agents('on_request'), ...agents('at_start')] }));
  }}><h2>Standing rule</h2><label>Answer<select name="answer" defaultValue={rule?.answer ?? 'ask'}>{choices}</select></label>
    <label>Automatic grant, minutes<Input name="minutes" type="number" min={1} max={525600} defaultValue={rule?.minutes ?? 30} required /></label>
    <label>When asked: agent names, separated by commas<Input name="on_request" defaultValue={assignments.filter(row => row.when === 'on_request').map(row => row.agent).join(', ')} /></label>
    <label>At startup: agent names, separated by commas<Input name="at_start" defaultValue={assignments.filter(row => row.when === 'at_start').map(row => row.agent).join(', ')} /></label>
    <Button disabled={command.busy}>Save rule</Button><p role="status">{command.message}</p>
  </form>;
}
