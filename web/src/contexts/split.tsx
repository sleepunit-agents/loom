import { useRef, useState } from 'react';
import { memberOperation } from '../data/operation';
import { keep, kept } from './ring';
import type { EntityTarget } from './entities';
import type { CommsMessage } from '../pieces/comms-view/model';

const fields = ['title', 'goal', 'why', 'doneWhen'] as const;
type Draft = Record<(typeof fields)[number], string>;
export function readSplit(words: string) {
  try {
    const value = JSON.parse(
      words
        .trim()
        .replace(/^\x60\x60\x60(?:json)?\s*/, '')
        .replace(/\s*\x60\x60\x60$/, ''),
    );
    if (
      typeof value.proposal !== 'string' ||
      !Array.isArray(value.drafts) ||
      value.drafts.length !== 2 ||
      !value.drafts.every((d: Draft) => d && fields.every((k) => typeof d[k] === 'string' && d[k].trim()))
    )
      return;
    return {
      proposal: value.proposal,
      drafts: value.drafts.map((d: Draft) => Object.fromEntries(fields.map((k) => [k, d[k]])) as Draft),
    };
  } catch {
    return;
  }
}
export const splitPrefix = 'Prepare a split proposal ';
export function splitPrompt(request: string, id: string, parent: string) {
  return (
    splitPrefix +
    id +
    ' for ' +
    parent +
    '. Read the ticket and its related work. Return just JSON ' +
    JSON.stringify({
      proposal: id,
      drafts: [
        { title: '', goal: '', why: '', doneWhen: '' },
        { title: '', goal: '', why: '', doneWhen: '' },
      ],
    }) +
    '. Fill the two drafts with concrete independent outcomes. This is a preview only. Leave all tickets untouched.\nRequest: ' +
    request
  );
}
export function splitFor(messages: CommsMessage[], ref: string, agent: string) {
  const start = messages.findLast(
    (m) =>
      m.kind === 'message' &&
      m.words?.split('\n')[0].endsWith(' · ' + ref + ']') &&
      m.words.split('\n')[1]?.startsWith(splitPrefix),
  );
  const id = start?.words?.split('\n')[1].slice(splitPrefix.length).split(' ')[0];
  if (!start || !id) return;
  for (const m of messages) {
    if (m.seq <= start.seq || m.kind !== 'reply' || m.sender !== agent) continue;
    const value = readSplit(m.words || '');
    if (value?.proposal === id) return { id, drafts: value.drafts };
  }
  return { id, drafts: undefined };
}
export function SplitProposal({
  id,
  parent,
  project,
  initial,
  working,
  open,
  receipt,
}: {
  id: string;
  parent: string;
  project: string | null;
  initial?: Draft[];
  working: boolean;
  open: (t: EntityTarget) => void;
  receipt: (text: string) => void;
}) {
  const key = 'context-split:' + id;
  const [drafts, edit] = useState<Draft[] | undefined>(() => readSplit(kept(key))?.drafts);
  const [state, setState] = useState(() => kept(key + ':state'));
  const [error, fail] = useState('');
  const lock = useRef(false);
  const values = drafts || initial;
  if (state === 'discarded') return null;
  if (state.startsWith('approved:'))
    return (
      <section className="module near">
        <h3>Split approved</h3>
        {state
          .slice(9)
          .split(',')
          .map((child) => (
            <button key={child} onClick={() => open({ kind: 'ticket', id: child })}>
              {child}
            </button>
          ))}
      </section>
    );
  function discard() {
    keep(key + ':state', 'discarded');
    setState('discarded');
    receipt('Discarded the split proposal for ' + parent + '.');
  }
  async function approve() {
    if (!values || lock.current) return;
    lock.current = true;
    setState('sending');
    keep(key + ':state', 'pending');
    fail('');
    try {
      const { children } = await memberOperation<{ children: string[] }>(
        'tasks.split',
        { parent, project, drafts: values },
        id,
      );
      const done = 'approved:' + children.join(',');
      keep(key + ':state', done);
      setState(done);
      receipt('Approved split of ' + parent + ' into ' + children.join(' and ') + '.');
    } catch {
      setState('pending');
      fail('Approval could not be confirmed. Retry to check the same approval.');
    } finally {
      lock.current = false;
    }
  }
  const pending = state === 'pending' || state === 'sending';
  return (
    <section className="module near">
      <h3>{values ? 'Split proposal' : working ? 'Art is drafting the split' : 'Split requested'}</h3>
      {!values && (
        <p>
          {working
            ? 'The drafts will appear here.'
            : 'Waiting for a reply with two drafts. Check the conversation for Art’s response.'}
        </p>
      )}
      {values?.map((d, i) => (
        <fieldset key={i} disabled={pending}>
          <legend>Draft {i + 1}</legend>
          {fields.map((k) => (
            <label key={k}>
              {k === 'doneWhen' ? 'Done when' : k}
              <textarea
                value={d[k]}
                onChange={(e) => {
                  const next = values.map((v, index) => (index === i ? { ...v, [k]: e.target.value } : v));
                  edit(next);
                  keep(key, JSON.stringify({ proposal: id, drafts: next }));
                }}
              />
            </label>
          ))}
        </fieldset>
      ))}
      {values && (
        <button
          disabled={state === 'sending' || values.some((d) => fields.some((k) => !d[k].trim()))}
          onClick={() => void approve()}
        >
          {pending ? 'Retry approval' : 'Approve split'}
        </button>
      )}
      {!pending && <button onClick={discard}>Discard proposal</button>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
