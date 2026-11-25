import { useEffect, useRef, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { newId } from '../data/id';
import { useDeadline } from '../pieces/comms/use-deadline';
import { threadPath } from '../pieces/attention/home-comms-data';
import type { CommsMessage } from '../pieces/comms-view/model';

const query = `query ContextConversation($id:String!){
  commsThread(id:$id){id agent member working}
  commsMessages(thread:$id,limit:50){seq kind sender clientId at words wordsKeepUntil delivery inboxItem}
}`;
type Reading = {
  commsThread: { id: string; member: string; agent: string; working: boolean } | null;
  commsMessages: CommsMessage[];
};
type Origin = { ticket: string; view: string };
export function useDiscussion(project: string, agent: string | null, member: string, key: string) {
  const [thread, setThread] = useState(() => {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false),
    alive = useRef(true);
  const retry = useRef<{ words: string; clientId: string } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const feed = useDataQuery<Reading>(query, { id: thread }, { pause: !thread || !agent });
  const read =
    feed.status === 'live' &&
    feed.data?.commsThread?.id === thread &&
    feed.data.commsThread.member === member &&
    feed.data.commsThread.agent === agent
      ? feed.data
      : undefined;
  const now = useDeadline(read?.commsMessages.map((m) => m.wordsKeepUntil) || []);
  const messages = (read?.commsMessages || []).filter(
    (m) =>
      m.words &&
      Date.parse(m.wordsKeepUntil ?? '') > now &&
      ['reply', 'message', 'notice', 'ask', 'answer'].includes(m.kind),
  );
  async function send(request: string, origin: Origin, onAttempt: (id: string) => void) {
    if (lock.current || !agent) return false;
    const words = '[Loom context · ' + origin.ticket + ' · ' + origin.view + ']\n' + request;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      // The server resolves this member's project discussion on each send:
      // deletion, audience changes and reopening are decided at the same door as Work.
      const { thread: id } = await memberOperation<{ thread: string }>('work.discuss', {
        kind: 'project',
        id: project,
        agent,
      });
      if (!alive.current) return false;
      setThread(id);
      try {
        localStorage.setItem(key, id);
      } catch {
        /* Private browsing */
      }
      if (retry.current?.words !== words) retry.current = { words, clientId: newId() };
      const clientId = retry.current.clientId;
      onAttempt(clientId);
      await memberOperation('comms.send', { thread: id, words, clientId }, clientId);
      retry.current = null;
      return true;
    } catch {
      if (alive.current) setError('Could not confirm delivery. Retry the same message to check it.');
      return false;
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return {
    messages,
    working: !!read?.commsThread?.working,
    busy,
    error,
    send,
    href: read ? threadPath(thread) : null,
    unavailable: !!thread && feed.status !== 'loading' && !read,
  };
}
