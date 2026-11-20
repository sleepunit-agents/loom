import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { useRecords, call, type Call, type LiveRecord } from '../../data';
import { AppFrame, List, Row, Empty, Error, Loading, Button, Input } from '../../kit';
interface Project extends LiveRecord { slug: string; name: string; members: string[]; agents: string[]; repositories: string[] }
interface Choices extends LiveRecord { members: string[]; agents: string[] }
const idle = { pending: false, status: 'done' as const };
const noop = () => () => {};
function ProjectForm({ project, choices, enabled }: { project?: Project; choices: Choices; enabled: boolean }) {
  const [request, setRequest] = useState<Call<Project>>();
  const state = useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => idle));
  function submit(event: FormEvent<HTMLFormElement>, field?: 'members' | 'agents') {
    event.preventDefault();
    if (!enabled || state.pending) return;
    const form = new FormData(event.currentTarget);
    const members = form.getAll('members'), agents = form.getAll('agents');
    setRequest(call<Project>(project ? `household.setProject${field === 'members' ? 'Members' : 'Agents'}` : 'household.createProject', project
      ? { slug: project.slug, [field!]: field === 'members' ? members : agents }
      : { slug: form.get('slug'), name: form.get('name'), repositories: [], members, agents }));
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
    {state.result && (state.result.ok ? <p role="status">Saved</p> : <Error title="Couldn’t save project" text={`${state.result.code}: ${state.result.message}`} />)}
  </section>;
}
export default function SharingApp({ go = () => {} }: { path?: string; go?: (path: string) => void } = {}) {
  const projects = useRecords<Project>('household.project');
  const options = useRecords<Choices>('household.sharing');
  const [selected, setSelected] = useState<string>();
  const project = projects.records.find(p => p.slug === selected);
  const live = projects.status === 'live' && options.status === 'live';
  const choices = options.records[0];
  return <AppFrame title="Project sharing" where="Sharing" go={go}>
    {projects.status === 'loading' || options.status === 'loading' ? <Loading label="Opening project sharing…" /> : !live ? <Error text="Project sharing is unavailable. Connect as a household owner." /> : !choices ? <Empty title="Household owners manage sharing" text="Ask an owner to put members and agents on a project." /> : <div className="grid gap-6 p-5">
      <p>A project shares its work with the members and agents on its lists.</p>
      <Button variant="outline" onClick={() => setSelected(undefined)}>New project</Button>
      <List label="Projects">{projects.records.map(p => <Row key={p.slug} title={p.name} meta={p.slug} status={`${p.members.length} members · ${p.agents.length} agents`} selected={p.slug === selected} onClick={() => setSelected(p.slug)} />)}</List>
      {!projects.records.length && <Empty title="No projects yet" text="Create a project to share work." />}
      <ProjectForm key={project?.slug ?? 'new'} project={project} choices={choices} enabled={live} />
    </div>}
  </AppFrame>;
}
