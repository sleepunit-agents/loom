import { useRef, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { newId } from '../data/id';
export function NewConversation({ open }: { open(id: string): void }) {
  const [editing, edit] = useState(false),
    [agent, choose] = useState(''),
    [title, setTitle] = useState(''),
    [busy, wait] = useState(false),
    [error, fail] = useState('');
  const roster = useDataQuery<{ homeComms: { agents: string[] } | null }>(
    '{homeComms{agents}}',
    {},
    { pause: !editing },
  );
  const people = roster.data?.homeComms?.agents || [],
    recipient = people.includes(agent) ? agent : people[0];
  const pending = useRef<{ key: string; id: string } | null>(null),
    lock = useRef(false);
  async function create() {
    const name = title.trim();
    if (!recipient || !name || lock.current) return;
    lock.current = true;
    wait(true);
    fail('');
    try {
      const key = JSON.stringify([recipient, name]);
      if (pending.current?.key !== key) pending.current = { key, id: newId() };
      const { id } = pending.current;
      const result = await memberOperation<{ thread: string }>(
        'comms.open',
        { thread: 'th:' + id, agent: recipient, title: name },
        id,
      );
      open(result.thread);
    } catch {
      fail('Could not confirm creation. Retry to check this conversation.');
    } finally {
      lock.current = false;
      wait(false);
    }
  }
  return editing ? (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <label>
        Agent
        <select value={recipient || ''} onChange={(e) => choose(e.target.value)}>
          {people.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <label>
        Conversation title
        <input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <button disabled={busy || !title.trim() || !recipient}>Create conversation</button>
      <button type="button" onClick={() => edit(false)}>
        Cancel
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  ) : (
    <button onClick={() => edit(true)}>New conversation</button>
  );
}
