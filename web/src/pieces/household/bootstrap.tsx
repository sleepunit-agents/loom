import { useSyncExternalStore, type FormEvent } from 'react';
import { call } from '../../data';
import { Button, Input } from '../../kit';
import { frozen, idle, mutation } from './model';
const noop = () => () => {};
export interface CreatedAgent { agent: string; contextDir: string; mcp: { command: string; args: string[] } }
export function createdAgent(value: unknown): CreatedAgent | undefined {
  if (!value || typeof value !== 'object' || !('agent' in value) || !('contextDir' in value) || !('mcp' in value)) return;
  return value as CreatedAgent;
}
export default function BootstrapAgent({ enabled }: { enabled: boolean }) {
  const held = useSyncExternalStore(mutation.subscribe, mutation.getSnapshot);
  const state = useSyncExternalStore(held.request?.subscribe ?? noop, held.request?.getSnapshot ?? (() => idle));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enabled || frozen(mutation.getSnapshot().request?.getSnapshot() ?? idle)) return;
    const data = new FormData(event.currentTarget);
    const input = Object.fromEntries(['agent', 'name', 'purpose', 'voice', 'rules', 'ask'].map(key => [key, String(data.get(key) ?? '')]));
    mutation.set(call('household.bootstrapAgent', input), `Create agent ${input.agent}`);
    event.currentTarget.querySelectorAll<HTMLInputElement>('input[data-confirm]').forEach(input => { input.checked = false; });
  };
  const made = held.label?.startsWith('Create agent ') && state.result?.ok ? createdAgent(state.result.value) : undefined;
  return <section aria-label="Create an agent" className="grid min-w-0 gap-3">
    <h2 className="text-xl font-semibold">Create an agent</h2>
    <p>Give a new agent its own identity, memory and relationships. It shares the household’s knowledge and people. Existing contexts are never overwritten.</p>
    <form aria-label="Create agent" onSubmit={submit} className="grid min-w-0 gap-3 rounded-xl border p-4"><fieldset disabled={!enabled} className="grid min-w-0 gap-3">
      <label className="grid gap-1">Short name<Input name="agent" required pattern="[a-z][a-z0-9-]*" maxLength={40} /></label>
      <label className="grid gap-1">Name<Input name="name" required maxLength={120} /></label>
      <label className="grid gap-1">What it’s for<textarea name="purpose" required maxLength={20000} /></label>
      <label className="grid gap-1">How it talks<textarea name="voice" required maxLength={20000} /></label>
      <label className="grid gap-1">Rules<textarea name="rules" maxLength={20000} /></label>
      <label className="grid gap-1">When to ask first<textarea name="ask" maxLength={20000} /></label>
      <label className="flex gap-2"><input type="checkbox" data-confirm required />I confirm this new agent’s creed</label>
      <Button type="submit" variant="outline">Create agent</Button>
    </fieldset></form>
    {made && <section aria-label="Agent ready" className="grid min-w-0 gap-3 rounded-xl border p-4"><h3 className="font-semibold">{made.agent} is ready</h3>
      <p>Its identity, preferences and self-model are saved. Create its first token in the form below, then save the token before leaving Setup.</p>
      <p>On a machine holding this household context, add this MCP server to your harness configuration:</p>
      <pre aria-label="Harness configuration" className="overflow-auto whitespace-pre-wrap break-all">{JSON.stringify({ mcpServers: { loom: made.mcp } }, null, 2)}</pre>
      <p>The home path is on the machine running the MCP server. Stdio loads identity and memory while loom is stopped. Remote API callers use the first token separately.</p>
      <p>At the start of every session, call loom’s identity tool before doing other work.</p>
    </section>}
  </section>;
}
