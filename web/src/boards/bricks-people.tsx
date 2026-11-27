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
import { Action, Actions, Chip, Few, Lead, Loading, More, Note, Problem, Row, Rows, Segmented, State, Unavailable, count, words, type Act, type Params, type Place } from './brick-kit';
import type { Form } from './layout';

const slug = /^[a-z0-9][a-z0-9._-]{0,99}$/, agentId = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,119}$/;
/** Where one card's row leads: see `personChip`. A card whose address a board cannot hold leads nowhere. */
const personPlace = (p: Pick<Person, 'slug' | 'kind' | 'ownership'>): Place | undefined => p.kind === 'agent'
  ? (agentId.test(p.slug) ? { brick: 'agent', params: { agent: p.slug } } : undefined)
  : slug.test(p.slug) ? { brick: 'person', params: { person: (p.ownership ? 'member:' : 'contact:') + p.slug } } : undefined;
/** The chip for one card: an agent's `agent` brick; a member's `person` brick under their member id, which is the
 * slug of a card that says what a member owns; anyone else's under `contact:`. */
export function personChip(p: Pick<Person, 'slug' | 'name' | 'kind' | 'ownership'>, label: string = p.name) {
  if (p.kind === 'agent') return agentId.test(p.slug) ? <Chip place={{ brick: 'agent', params: { agent: p.slug } }}>{label}</Chip> : <span>{label}</span>;
  return slug.test(p.slug) ? <Chip place={{ brick: 'person', params: { person: (p.ownership ? 'member:' : 'contact:') + p.slug } }}>{label}</Chip> : <span>{label}</span>;
}
/** What mind.personAdd takes as `channel` (src/pieces/mind/people-actions.ts), in People's words. */
const channels = [['', 'Not yet'], ['slack', 'slack'], ['discord', 'discord'], ['email', 'email'], ['phone', 'phone'], ['github', 'github']].map(([value, label]) => ({ value, label }));
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
    <Actions>
      <Action onClick={() => { setAdded(''); setOpen(true); }}>Add a person</Action>
      {added && <span role="status" className="board-note">Added to People {personChip({ slug: added, name: '', kind: 'person' }, 'Open person')}</span>}
    </Actions>
  );
  return (
    <form className="board-form" aria-label="Add a person" onSubmit={(e) => void save(e)}>
      <Note>Contact details are shared. Their summary belongs to the default agent’s relationship.</Note>
      <label className="board-field"><span>Name</span><input className="board-input" required maxLength={80} value={draft.name} disabled={busy} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="board-field"><span>Who they are</span><textarea className="board-input" rows={2} maxLength={1200} value={draft.summary} disabled={busy} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} /></label>
      <Segmented<string> label="Reach them on" value={draft.channel} options={channels} onChange={(channel) => setDraft({ ...draft, channel })} disabled={busy} />
      <label className="board-field"><span>Their handle or address</span><input className="board-input" maxLength={200} value={draft.handle} disabled={busy} onChange={(e) => setDraft({ ...draft, handle: e.target.value })} /></label>
      <Actions>
        <Action submit kind="primary" disabled={busy || !draft.name.trim()}>Add</Action>
        <Action kind="quiet" disabled={busy} onClick={() => setOpen(false)}>Cancel</Action>
      </Actions>
      <Problem>{error}</Problem>
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
  const everyone = `${count(people, 'person', 'people')} · ${count(agents, 'agent')}`;
  if (form === 'compact') return <p className="board-brief">{everyone}</p>;
  const big = form === 'primary', cap = big ? 60 : 3;
  return (
    <>
      <Lead>{folder === 'all' ? everyone : folder === 'agent' ? count(shown.length, 'agent') : count(shown.length, 'person', 'people')}</Lead>
      <div className="board-meta"><span>{folderWord[folder] ?? folder}</span></div>
      {big && (
        <div className="board-search" role="search">
          <input className="board-input" type="search" aria-label="Search people" placeholder="Search people…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      {shown.length > 0 && (
        <Few of={shown} first={cap} fit={!big}>{(some, hidden) => <><Rows beside>{some.map((g) => {
          const stale = g.person.fields.some((f) => f.state === 'stale');
          return (
            <Row key={g.person.id} place={personPlace(g.person)} title={g.person.name}
              meta={big && g.relationships.length ? `Known to ${g.relationships.map((p) => p.agent).join(', ')}` : undefined}
              end={<State tone={stale ? 'waiting' : 'muted'}>{stale ? 'Stale contact details' : g.person.kind}</State>} />
          );
        })}</Rows><More n={hidden} /></>}</Few>
      )}
      {!shown.length && <Note>{big && query.trim() ? 'Nothing matches.' : all.length ? 'No contacts here' : 'No people yet'}</Note>}
      {big && may.directory && !may.canAdd && (
        <Note>{may.agents.length ? 'Ask an agent in Comms to set your household’s default agent before adding a person.' : 'Add a household agent and choose it as the default before adding a person.'}</Note>
      )}
      {big && may.canAdd && <AddPerson act={act} />}
    </>
  );
}
