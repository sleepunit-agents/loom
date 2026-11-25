import { createContext, useContext, useLayoutEffect } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { linkedEntity } from './entity-links';
import { recordQuote } from './record-quote';
import type { EntityTarget } from './entities';

type Row = Record<string, unknown>;
export type FieldFocus = { target: EntityTarget; open(t: EntityTarget): void; quote(words: string): void };
export const FieldContext = createContext<FieldFocus | null>(null);
const label = (field: string) =>
  field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
function object(value: unknown): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function identity(value: unknown) {
  const id =
    object(value) && ['id', 'ref', 'slug', 'seq', 'fingerprint', 'key'].find((k) => value[k] != null);
  const canonical = JSON.stringify(id && object(value) ? [id, value[id]] : value);
  return Array.from(sha256(new TextEncoder().encode(canonical)), (n) => n.toString(16).padStart(2, '0')).join(
    '',
  );
}
function at(root: Row, path: string[]): unknown {
  let item: unknown = root;
  for (const key of path) {
    if (Array.isArray(item)) item = item.find((v) => identity(v) === key);
    else if (object(item) && Object.hasOwn(item, key)) item = item[key];
    else return;
  }
  return item;
}
function Fields({ row, path, expand }: { row: Row; path: string[]; expand?(path: string[]): void }) {
  const ctx = useContext(FieldContext);
  function reference(k: string, v: unknown) {
    if (typeof v !== 'string') return;
    if (k === 'href' || k === 'url') return linkedEntity(v);
    const fields: Record<string, EntityTarget['kind']> = {
      task: 'ticket',
      dependsOn: 'ticket',
      sourceTask: 'ticket',
      change: 'change',
      project: 'project',
      agent: 'agent',
      member: 'member',
      box: 'box',
      secret: 'secret',
      approval: 'approval',
      conversation: 'episode',
      trigger: 'trigger',
      digest: 'digest',
      connection: 'bridge',
      inboxItem: 'question',
    };
    return Object.hasOwn(fields, k) ? { kind: fields[k], id: v } : undefined;
  }
  return (
    <dl className="entityFacts">
      {Object.entries(row)
        .filter(([k, v]) => k !== '__typename' && v != null && v !== '' && (!Array.isArray(v) || v.length))
        .map(([k, value]) => (
          <div key={k}>
            <dt>{label(k)}</dt>
            <dd>
              {Array.isArray(value) ? (
                <ul>
                  {value.map((v, i) => (
                    <li key={i}>
                      {object(v) ? (
                        <>
                          {expand && (
                            <button onClick={() => expand([...path, k, identity(v)])}>
                              Open {String(v.title || v.name || v.label || v.id || label(k))}
                            </button>
                          )}
                          <details>
                            <summary>Details</summary>
                            <Fields row={v} path={[...path, k, identity(v)]} expand={expand} />
                          </details>
                        </>
                      ) : expand ? (
                        <button onClick={() => expand([...path, k, identity(v)])}>{String(v)}</button>
                      ) : (
                        String(v)
                      )}
                    </li>
                  ))}
                </ul>
              ) : object(value) ? (
                <>
                  {expand && <button onClick={() => expand([...path, k])}>Open {label(k)}</button>}
                  <Fields row={value} path={[...path, k]} expand={expand} />
                </>
              ) : ctx && reference(k, value) ? (
                <button onClick={() => ctx.open(reference(k, value)!)}>
                  {k === 'href' || k === 'url' ? 'Open source' : String(value)}
                </button>
              ) : typeof value === 'boolean' ? (
                value ? (
                  'Yes'
                ) : (
                  'No'
                )
              ) : (
                String(value)
              )}
            </dd>
          </div>
        ))}
    </dl>
  );
}
export function Facts({ row, section = 'record' }: { row: Row; section?: string }) {
  const ctx = useContext(FieldContext);
  const path = ctx?.target.part?.[0] === section ? ctx.target.part.slice(1) : [];
  const value = at(row, path);
  const active = !ctx?.target.part || ctx.target.part[0] === section;
  const current = object(value) ? value : value == null ? null : { value };
  const excerpt = active && current ? recordQuote(current) : '';
  const quote = ['related', 'machine'].includes(section) && !ctx?.target.part ? undefined : ctx?.quote;
  useLayoutEffect(() => {
    if (!active || !quote) return;
    quote(excerpt);
    return () => quote('');
  }, [active, quote, excerpt]);
  if (!active) return null;
  if (!current) return <p>Record unavailable.</p>;
  return (
    <Fields
      row={current}
      path={path}
      expand={ctx ? (keys) => ctx.open({ ...ctx.target, part: [section, ...keys] }) : undefined}
    />
  );
}
