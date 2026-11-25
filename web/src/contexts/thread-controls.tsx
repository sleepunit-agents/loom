import { useRef, useState } from 'react';
import { memberOperation } from '../data/operation';
import { newId } from '../data/id';
import type { CommsThread, ThreadChange } from '../pieces/comms-view/model';

export function ThreadControls({ thread, leave }: { thread: CommsThread; leave(): void }) {
  const [draft, write] = useState(''),
    [title, rename] = useState(thread.title),
    [busy, working] = useState(false),
    [error, fail] = useState(''),
    [deleting, remove] = useState(false);
  const pending = useRef<{ words: string; id: string } | null>(null),
    lock = useRef(false);
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    working(true);
    fail('');
    try {
      await action();
    } catch {
      fail('Could not confirm the change. Check the conversation and retry.');
    } finally {
      working(false);
      lock.current = false;
    }
  }
  const change = (input: ThreadChange) =>
    run(async () => {
      await memberOperation('comms.change', { thread: thread.id, ...input });
      if (input.change === 'delete') leave();
    });
  async function send() {
    const words = draft.trim();
    if (!words) return;
    await run(async () => {
      if (pending.current?.words !== words) pending.current = { words, id: newId() };
      const clientId = pending.current.id;
      await memberOperation('comms.send', { thread: thread.id, words, clientId }, clientId);
      pending.current = null;
      write((prev) => (prev.trim() === words ? '' : prev));
    });
  }
  return (
    <div className="threadControls">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label>
          Reply to {thread.agent} in this conversation
          <textarea value={draft} onChange={(e) => write(e.target.value)} />
        </label>
        <button disabled={busy || !draft.trim()}>Send reply</button>
      </form>
      <details>
        <summary>Manage conversation</summary>
        <fieldset disabled={busy}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void change({ change: 'rename', title: title.trim() });
            }}
          >
            <label>
              Title
              <input value={title} onChange={(e) => rename(e.target.value)} />
            </label>
            <button disabled={!title.trim() || title === thread.title}>Rename</button>
          </form>
          <button onClick={() => void change({ change: 'pin', pinned: !thread.pinned })}>
            {thread.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button onClick={() => void change({ change: 'archive', archived: !thread.archivedAt })}>
            {thread.archivedAt ? 'Restore conversation' : 'Archive conversation'}
          </button>
          {thread.working && <button onClick={() => void change({ change: 'stop' })}>Stop work</button>}
          {deleting ? (
            <>
              <p>Permanently delete this conversation and its messages?</p>
              <button onClick={() => void change({ change: 'delete' })}>Delete permanently</button>
              <button onClick={() => remove(false)}>Keep conversation</button>
            </>
          ) : (
            <button onClick={() => remove(true)}>Delete conversation…</button>
          )}
        </fieldset>
      </details>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
