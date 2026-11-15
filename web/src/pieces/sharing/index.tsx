import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useDataQuery } from '../../data/graphql';
import { memberOperation } from '../../data/operation';
import { sharingQuery, type SharingProject, type SharingChoices, type SharingData } from './query';
import { AppFrame, List, Row, Empty, Error, Loading, Button, Input } from '../../kit';
function ProjectForm({ project, choices, enabled }: { project?: SharingProject; choices: SharingChoices; enabled: boolean }) {
  const [state, setState] = useState<{ pending: boolean; saved?: boolean; error?: string }>({ pending: false });
  const busy = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent<HTMLFormElement>, field?: 'members' | 'agents') {
    event.preventDefault();
    if (!enabled || busy.current) return;
    const form = new FormData(event.currentTarget);
    const members = form.getAll('members'), agents = form.getAll('agents');
    const slug = project?.id ?? String(form.get('slug') ?? '');
    busy.current = true; setState({ pending: true });
    try {
      const saved = await memberOperation<{ id: string }>(project ? `household.setProject${field === 'members' ? 'Members' : 'Agents'}` : 'household.createProject', project
        ? { slug, [field!]: field === 'members' ? members : agents }
        : { slug, name: String(form.get('name') ?? ''), members, agents });
      if (saved?.id !== slug) throw new globalThis.Error('Unconfirmed project');
      if (mounted.current) setState({ pending: false, saved: true });
    } catch {
      if (mounted.current) setState({ pending: false, error: 'Could not confirm this change. Check current sharing and try again.' });
    } finally { busy.current = false; }
  }
  const checkboxes = (field: 'members' | 'agents') => <fieldset className="grid gap-2"><legend>{field === 'members' ? 'Members' : 'Agents'}</legend>{choices[field].map(id => <label key={id} className="flex gap-2"><input type="checkbox" name={field} value={id} defaultChecked={project?.[field].includes(id)} />{id}</label>)}</fieldset>;
  return <section className="grid gap-4">
    <h2 className="text-xl font-semibold">{project ? project.name : 'Create project'}</h2>
    {project ? (['members','agents'] as const).map(field => <form key={`${field}:${project[field].join(',')}`} aria-label={`Project ${field}`} onSubmit={event => submit(event, field)}>
      <fieldset disabled={!enabled || state.pending} className="grid gap-3">{checkboxes(field)}<Button type="submit" variant="outline">Save {field}</Button></fieldset>
    </form>) : <form aria-label="Create project" onSubmit={submit}>
      <fieldset disabled={!enabled || state.pending} className="grid gap-3">
        <label className="grid gap-1">Name<Input name="name" required maxLength={200} /></label>
        <label className="grid gap-1">Slug<Input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={100} placeholder="my-project" /></label>
        {checkboxes('members')}{checkboxes('agents')}<Button type="submit" variant="outline">Create project</Button>
      </fieldset>
    </form>}
    {state.pending && <Loading label="Saving project…" />}
    {state.saved && <p role="status">Saved</p>}
    {state.error && <Error title="Couldn’t save project" text={state.error} />}
  </section>;
}
export default function SharingApp({ go = () => {} }: { path?: string; go?: (path: string) => void } = {}) {
  const reading = useDataQuery<SharingData>(sharingQuery);
  const [selected, setSelected] = useState<string>();
  const live = reading.status === 'live';
  const choices = live ? reading.data?.projectSharing : undefined;
  const projects = choices?.projects ?? [];
  const project = projects.find(p => p.id === selected);
  return <AppFrame title="Project sharing" where="Sharing" go={go}>
    {reading.status === 'loading' || live && !reading.data ? <Loading label="Opening project sharing…" /> : !live ? <Error text="Project sharing is unavailable. Connect as a household owner." /> : !choices ? <Empty title="Household owners manage sharing" text="Ask an owner to put members and agents on a project." /> : <div className="grid gap-6 p-5">
      <p>A project shares its work with the members and agents on its lists.</p>
      <Button variant="outline" onClick={() => setSelected(undefined)}>New project</Button>
      <List label="Projects">{projects.map(p => <Row key={p.id} title={p.name} meta={p.id} status={`${p.members.length} members · ${p.agents.length} agents`} selected={p.id === selected} onClick={() => setSelected(p.id)} />)}</List>
      {!projects.length && <Empty title="No projects yet" text="Create a project to share work." />}
      <ProjectForm key={project?.id ?? 'new'} project={project} choices={choices} enabled={live} />
    </div>}
  </AppFrame>;
}
