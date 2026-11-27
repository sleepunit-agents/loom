/** The `people` brick: the directory the desktop's People app lists (memory/queries.ts, memoryPeople), grouped and
 * searched by its own rule (pieces/people/model.ts, contacts), each person a chip that places their `person` brick
 * and each agent a chip for its `agent` brick. Big, it has People's search and its "Add a person". What the member
 * types to search is state of this drawn brick and filters the list loom already sent: it is never a parameter and
 * the board never holds it. A new person's words go to mind.personAdd and nowhere else. */
import { useRef, useState, type FormEvent } from 'react';
import { memberOperation } from '../data/operation';
import { memoryQueries } from '../memory/queries';
import { useMemoryQuery } from '../memory/query';
import { contacts, type Person } from '../pieces/people/model';
import { Chip, Loading, Unavailable, words, type Act, type Params } from './bricks';
import type { Form } from './layout';

const slug = /^[a-z0-9][a-z0-9._-]{0,99}$/, agentId = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,119}$/;
/** The chip for one card: an agent's `agent` brick; a member's `person` brick under their member id, which is the
 * slug of a card that says what a member owns; anyone else's under `contact:`. */
export function personChip(p: Pick<Person, 'slug' | 'name' | 'kind' | 'ownership'>, label: string = p.name) {
  if (p.kind === 'agent') return agentId.test(p.slug) ? <Chip place={{ brick: 'agent', params: { agent: p.slug } }}>{label}</Chip> : <span>{label}</span>;
  return slug.test(p.slug) ? <Chip place={{ brick: 'person', params: { person: (p.ownership ? 'member:' : 'contact:') + p.slug } }}>{label}</Chip> : <span>{label}</span>;
}
/** What mind.personAdd takes as `channel` (src/pieces/mind/people-actions.ts), in People's words. */
const channels = [['', 'Not yet'], ['slack', 'slack'], ['discord', 'discord'], ['email', 'email'], ['phone', 'phone'], ['github', 'github']] as const;
const blank = { name: '', summary: '', channel: '', handle: '' };
const folderWord: Record<string, string> = { all: 'Everyone', person: 'People', agent: 'Agents' };

function AddPerson({ act }: { act: Act }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(blank);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [added, setAdded] = useState('');
  const lock = useRef(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (lock.current || !draft.name.trim()) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const made = await memberOperation<{ slug: string }>('mind.personAdd', draft);
      act('add', {});
      setAdded(made?.slug ?? ''); setDraft(blank); setOpen(false);
    } catch { setError('That did not save. A person needs a name that makes an address no one else has.'); }
    finally { lock.current = false; setBusy(false); }
  };
  if (!open) return (
    <div className="board-line">
      <button type="button" className="board-action" onClick={() => { setAdded(''); setOpen(true); }}>Add a person</button>
      {added && <span role="status">Added to People {personChip({ slug: added, name: '', kind: 'person' }, 'Open person')}</span>}
    </div>
  );
  return (
    <form aria-label="Add a person" onSubmit={(e) => void save(e)}>
      <p className="text-muted-foreground">Contact details are shared. Their summary belongs to the default agent’s relationship.</p>
      <label className="board-line">Name<input className="board-input" required maxLength={80} value={draft.name} disabled={busy} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="board-line">Who they are<textarea className="board-input" maxLength={1200} value={draft.summary} disabled={busy} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} /></label>
      <div className="board-line" role="group" aria-label="Reach them on">Reach them on
        {channels.map(([value, word]) => <button key={value} type="button" className="board-action" aria-pressed={draft.channel === value} disabled={busy} onClick={() => setDraft({ ...draft, channel: value })}>{word}</button>)}
      </div>
      <label className="board-line">Their handle or address<input className="board-input" maxLength={200} value={draft.handle} disabled={busy} onChange={(e) => setDraft({ ...draft, handle: e.target.value })} /></label>
      <div className="board-line">
        <button type="submit" className="board-action" disabled={busy || !draft.name.trim()}>Add</button>
        <button type="button" className="board-action" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </form>
  );
}

export function People({ params, form, act }: { params: Params; form: Form; act: Act }) {
  const folder = words(params.folder) || 'all';
  const access = useMemoryQuery(memoryQueries.peopleAccess());
  const feed = useMemoryQuery(memoryQueries.people());
  const [query, setQuery] = useState('');
  if (access.status === 'loading' || feed.status === 'loading') return <Loading />;
  const may = access.value;
  if (access.status !== 'live' || !may?.allowed || feed.status !== 'live' || !feed.value) return <Unavailable what="directory" />;
  const all = contacts(feed.value, 'all', '', ''), shown = contacts(feed.value, folder, form === 'primary' ? query : '', '');
  const people = all.filter((g) => g.person.kind === 'person').length, agents = all.length - people;
  const count = `${people} ${people === 1 ? 'person' : 'people'} · ${agents} agent${agents === 1 ? '' : 's'}`;
  if (form === 'compact') return <p className="board-brief">{count}</p>;
  const cap = form === 'primary' ? 60 : 6;
  return (
    <>
      <p className="board-line"><span>{folderWord[folder] ?? folder} · {folder === 'all' ? count : shown.length}</span></p>
      {form === 'primary' && (
        <div className="board-line" role="search">
          <input className="board-input" type="search" aria-label="Search people" placeholder="Search people…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      {shown.slice(0, cap).map((g) => (
        <div className="board-line" key={g.person.id}>
          {personChip(g.person)}
          <span className="board-state">{g.person.fields.some((f) => f.state === 'stale') ? 'Stale contact details' : g.person.kind}</span>
          {form === 'primary' && <span className="text-muted-foreground">{g.relationships.length ? `Known to ${g.relationships.map((p) => p.agent).join(', ')}` : 'No relationship cards available'}</span>}
        </div>
      ))}
      {shown.length > cap && <p className="text-muted-foreground">and {shown.length - cap} more</p>}
      {!shown.length && <p className="text-muted-foreground">{form === 'primary' && query.trim() ? 'Nothing matches.' : all.length ? 'No contacts here' : 'No people yet'}</p>}
      {form === 'primary' && may.directory && !may.canAdd && (
        <p className="text-muted-foreground">{may.agents.length ? 'Ask an agent in Comms to set your household’s default agent before adding a person.' : 'Add a household agent and choose it as the default before adding a person.'}</p>
      )}
      {form === 'primary' && may.canAdd && <AddPerson act={act} />}
    </>
  );
}
