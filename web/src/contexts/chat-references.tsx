import { Fragment } from 'react';
import { entityAddress, entityAt, entityName, type EntityTarget } from './entities';

/** Agent words can offer a record to open. Following the reference is a member action. */
export function ChatReferences({ words }: { words: string }) {
  const parts = words.split(
    /(\[[^\]\n]{1,100}\]\(#entity\/[^)\s]+\)|\b(?:t-\d+|th:[\w-]+|github:[\w.-]+\/[\w.-]+#\d+)\b)/gi,
  );
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
        const link = /^\[([^\]]+)\]\(#([^)]*)\)$/.exec(part);
        let ref: EntityTarget | null;
        if (link) ref = entityAt(link[2]);
        else if (/^t-\d+$/i.test(part)) ref = { kind: 'ticket', id: part.toLowerCase() };
        else if (part.startsWith('th:')) ref = { kind: 'conversation', id: part };
        else ref = { kind: 'change', id: part };
        return ref ? (
          <a key={i} href={'#' + entityAddress(ref)} title={'Open ' + entityName(ref)}>
            {link ? link[1] : part}
          </a>
        ) : (
          part
        );
      })}
    </>
  );
}
