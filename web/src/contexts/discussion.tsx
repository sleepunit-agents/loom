import { useEffect, useRef, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { sha256 } from '@noble/hashes/sha2.js';
import { newId } from '../data/id';
import { useDeadline } from '../pieces/comms/use-deadline';
import type { CommsMessage } from '../pieces/comms-view/model';

const query = `query ContextConversation($id:String!){
  commsThread(id:$id){id agent member working conversation readSeq}
  commsMessages(thread:$id,limit:50){seq kind sender clientId at words wordsKeepUntil delivery inboxItem}
}`;
type Reading = {
  commsThread: {
    id: string;
    member: string;
    agent: string;
    working: boolean;
    conversation: string;
    readSeq: number;
  } | null;
  commsMessages: CommsMessage[];
};
type Origin = { ticket: string; view: string };
export function useDiscussion(
  project: string,
  agent: string | null,
  member: string,
  key: string,
  namedThread?: string,
) {
  const [thread, setThread] = useState(() => {
    try {
      return namedThread || localStorage.getItem(key) || '';
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
  const conversation = read?.commsThread?.conversation;
  const questions = useDataQuery<{ inboxItems: { id: string; answers: string | null }[] }>(
    'query ContextNeeds($conversation:String!){inboxItems(conversation:$conversation,state:"waiting",folder:"needs",limit:50){id answers}}',
    { conversation: conversation || '' },
    { pause: !conversation },
  );
  async function resolveThread() {
    if (namedThread) return namedThread;
    const homeId =
      'th:home-' +
      Array.from(sha256(new TextEncoder().encode(JSON.stringify([member, agent]))), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
    const { thread: id } = project
      ? await memberOperation<{ thread: string }>('work.discuss', {
          kind: 'project',
          id: project,
          agent,
        })
      : await memberOperation<{ thread: string }>('comms.open', {
          thread: homeId,
          agent,
          title: 'Workspace',
        });
    if (alive.current) {
      setThread(id);
      try {
        localStorage.setItem(key, id);
      } catch {
        /* Session only */
      }
    }
    return id;
  }
  async function enter() {
    if (thread || !agent) return;
    try {
      await resolveThread();
    } catch {
      if (alive.current) setError('Could not open this conversation.');
    }
  }
  async function send(request: string, origin: Origin, onAttempt: (id: string) => void) {
    if (lock.current || !agent) return false;
    const words = '[Loom context · ' + origin.ticket + ' · ' + origin.view + ']\n' + request;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      // The server resolves this member's project discussion on each send:
      // deletion, audience changes and reopening are decided at the same door as Work.
      const id = await resolveThread();
      if (!alive.current) return false;
      if (retry.current?.words !== words) retry.current = { words, clientId: newId() };
      const digest = Array.from(sha256(new TextEncoder().encode(JSON.stringify([member, id, words]))), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      const pendingKey = 'loom:context-send:' + digest;
      try {
        retry.current.clientId = sessionStorage.getItem(pendingKey) || retry.current.clientId;
        sessionStorage.setItem(pendingKey, retry.current.clientId);
      } catch {
        /* In-memory retry on this mount. */
      }
      const clientId = retry.current.clientId;
      onAttempt(clientId);
      await memberOperation('comms.send', { thread: id, words, clientId }, clientId);
      try {
        sessionStorage.removeItem(pendingKey);
      } catch {
        /* In-memory only. */
      }
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
    enter,
    thread,
    readSeq: read?.commsThread?.readSeq ?? 0,
    questions:
      questions.status === 'live'
        ? questions.data?.inboxItems.filter((i) => i.answers).map((i) => i.id) || []
        : [],
    working: !!read?.commsThread?.working,
    busy,
    error,
    send,
    available: !!read,
    unavailable: !!thread && feed.status !== 'loading' && !read,
  };
}
