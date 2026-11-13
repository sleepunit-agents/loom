import { useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { call, useRecords } from '../../data';
import { AppFrame, Button, Input, Empty, Error, Loading } from '../../kit';
import { accountInput, memberInput, mutation, idle, frozen, type Household, type Project } from './model';
const noop = () => () => {};
function CheckList({ name, choices, selected = [] }: { name: string; choices: string[]; selected?: string[] }) {
  return <div className="grid gap-2">{choices.map(id => <label key={id} className="flex items-center gap-2"><input type="checkbox" name={name} value={id} defaultChecked={selected.includes(id)} />{id}</label>)}</div>;
}
export default function SetupApp({ go = () => {} }: { path?: string; go?: (path: string) => void } = {}) {
  const feed = useRecords<Household>('household.sharing'), projects = useRecords<Project>('household.project');
  const held = useSyncExternalStore(mutation.subscribe, mutation.getSnapshot);
  const state = useSyncExternalStore(held.request?.subscribe ?? noop, held.request?.getSnapshot ?? (() => idle));
  const h = feed.records[0], enabled = feed.status === 'live' && !!h && !frozen(state);
  const submit = (label: string, operation: string, input: (form: FormData) => unknown) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const active = mutation.getSnapshot().request;
    if (!enabled || active && frozen(active.getSnapshot())) return;
    const data = input(new FormData(event.currentTarget));
    mutation.set(call(operation, data), label);
    event.currentTarget.querySelectorAll<HTMLInputElement>('input[data-confirm]').forEach(input => { input.checked = false; });
  };
  const form = (label: string, operation: string, input: (data: FormData) => unknown, children: ReactNode, available = true) => <form aria-label={label} onSubmit={submit(label, operation, input)} className="grid gap-3 rounded-xl border p-4"><fieldset disabled={!enabled || !available} className="grid min-w-0 gap-3">{children}<Button type="submit" variant="outline">{label}</Button></fieldset></form>;
  const link = (label: string, path: string) => <Button variant="outline" onClick={() => go(path)}>{label}</Button>;
  return <AppFrame title="Household setup" where="Setup" go={go}>
    <div className="grid min-w-0 gap-6 overflow-auto p-4 sm:p-6">
      <p>Manage the household’s members, agent ownership and project access.</p>
      {feed.status === 'loading' ? <Loading label="Opening household…" /> : feed.status === 'denied' ? <Error text="Household setup is only available to household owners." /> : !h ? <Empty title="Household setup is unavailable" text="Sign in as a household owner and check the connection." /> : <>
        {feed.status !== 'live' && <Error text="Connection lost. Changes are disabled until the household reconnects." />}
        {held.request && <section aria-label="Last setup change" className="grid gap-2" aria-live="polite"><p>{held.label}</p>{state.pending ? <Loading label={state.status === 'offline' ? 'Waiting for connection…' : 'Saving…'} /> : state.result?.ok ? <p role="status">Saved</p> : state.result && <><Error title="Couldn’t save" text={`${state.result.code}: ${state.result.message}`} />{state.result.code === 'unavailable' && <><p>The result is uncertain. Retry this change before making another.</p><Button disabled={feed.status !== 'live'} onClick={() => held.request?.retry?.()}>Retry this change</Button></>}</>}</section>}
        <section className="grid gap-3"><h2 className="text-xl font-semibold">Agents</h2><p>Default agent: {h.defaultAgent}</p>
          {h.agents.map(agent => <section key={agent} className="grid min-w-0 gap-2"><h3 className="font-semibold">{agent}</h3>{form(`Save accounts for ${agent}`, 'household.setAgentAccounts', data => accountInput(data, agent), <label key={(h.agentAccounts[agent]?.github ?? []).join(',')} className="grid gap-1">GitHub accounts<Input name="github" defaultValue={(h.agentAccounts[agent]?.github ?? []).join(', ')} maxLength={4000} /><span className="text-sm text-muted-foreground">Comma-separated logins used for attribution. These do not grant access.</span></label>)}</section>)}
          {form('Register existing agent', 'household.addAgent', data => ({ agent: data.get('agent') }), <><p>Register a context already prepared in the household’s agents directory.</p><label className="grid gap-1">Agent name<Input name="agent" required pattern="[a-z][a-z0-9-]*" maxLength={40} /></label><p className="text-sm text-muted-foreground">This does not create an identity or a first token.</p></>)}
        </section>
        <section className="grid gap-4"><h2 className="text-xl font-semibold">Members</h2><p>Household owners manage every agent and membership. Scoped members keep their recorded role. At least one household owner must remain.</p>
          {h.membership.map(member => <article key={member.person} className="grid min-w-0 gap-3 border-t pt-4"><h3 className="font-semibold">{member.person}</h3><p>{member.agents === '*' ? 'Household owner · every agent' : `${member.role} · ${member.agents.join(', ') || 'no owned agents'}`}</p>
            {form(`Save ownership for ${member.person}`, 'household.setMember', memberInput, <div key={JSON.stringify(member)} className="grid gap-3"><input type="hidden" name="person" value={member.person} /><label className="grid gap-1">Ownership<select name="ownership" defaultValue={member.agents === '*' ? 'household' : 'scoped'}><option value="scoped">Selected agents</option><option value="household">Whole household</option></select></label><fieldset className="grid gap-2"><legend>Selected agents (used for scoped ownership)</legend><CheckList name="agents" choices={h.agents} selected={member.agents === '*' ? [] : member.agents} /></fieldset><label className="flex gap-2"><input type="checkbox" data-confirm required />I confirm this ownership change</label></div>)}
            {projects.status === 'live' ? form(`Save projects for ${member.person}`, 'household.setMemberProjects', data => ({ person: member.person, projects: data.getAll('projects') }), <fieldset key={JSON.stringify(projects.records.map(p => [p.slug, p.members]))} className="grid gap-2"><legend>Project access</legend><CheckList name="projects" choices={projects.records.map(p => p.slug)} selected={projects.records.filter(p => p.members.includes(member.person)).map(p => p.slug)} />{member.agents === '*' && <p>Household owners can already see all projects.</p>}</fieldset>) : <p>Project access is unavailable until connected.</p>}
            {form(`Remove ${member.person}`, 'household.removeMember', () => ({ person: member.person }), <><p>Removal ends current access. Retained credentials and project assignments work again if this person is re-added; remove credentials separately to keep them disabled.</p><label className="flex gap-2"><input type="checkbox" data-confirm required />I confirm removing {member.person}</label></>)}
          </article>)}
          {form('Add member', 'household.setMember', memberInput, <><p>Choose a person’s exact slug from People. New scoped members are agent owners and must own at least one agent.</p><label className="grid gap-1">Person slug<Input name="person" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={100} /></label><label className="grid gap-1">Ownership<select name="ownership"><option value="scoped">Selected agents</option><option value="household">Whole household</option></select></label><fieldset className="grid gap-2"><legend>Owned agents</legend><CheckList name="agents" choices={h.agents} /></fieldset><label className="flex gap-2"><input type="checkbox" data-confirm required />I confirm granting this ownership</label></>)}
        </section>
        <nav aria-label="Related setup" className="flex flex-wrap gap-2">{link('Open People', '/p/people-preview')}{link('Open Project sharing', '/p/sharing-preview')}</nav>
      </>}
    </div>
  </AppFrame>;
}
