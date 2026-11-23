import { useEffect, useRef, useState } from 'react';
import { memberOperation } from '../../data/operation';
import { Actions, Error, LinkButton } from '../../kit';
import { useDeskAgentDirectory } from './agent-directory';
import { threadPath } from './home-comms-data';

export function InboxDiscussion({ item, agent, go }: { item: string; agent: string; go?(path: string): void }) {
  const directory = useDeskAgentDirectory();
  const name = directory.records.find(person => person.slug === agent)?.name ?? agent.replace(/^./, first => first.toUpperCase());
  const [state, setState] = useState<'idle' | 'opening' | 'failed'>('idle');
  const locked = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function open() {
    if (locked.current) return;
    locked.current = true;
    setState('opening');
    try {
      const { thread } = await memberOperation<{ thread: string }>('inbox.discuss', { item, expectedAgent: agent });
      if (!mounted.current) return;
      const path = threadPath(thread);
      if (go) go(path);
      else window.location.assign(path);
      setState('idle');
    } catch {
      if (mounted.current) setState('failed');
    } finally {
      locked.current = false;
    }
  }
  return <>
    <Actions><LinkButton disabled={state === 'opening'} onClick={() => void open()}>
      {state === 'opening' ? 'Opening conversation…' : `Discuss with ${name}`}
    </LinkButton></Actions>
    {state === 'failed' && <Error text="Could not open the conversation. Try again." />}
  </>;
}
