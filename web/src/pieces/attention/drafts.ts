import { useEffect, useState } from 'react';
import { newId } from '../../comms-id';

export interface Draft { version: string; text: string }
export interface ReplyDraft {
  value: Draft;
  edit(text: string): void;
  acknowledged(sent: Draft): void;
  persistent: boolean;
}
const empty: Draft = { version: '', text: '' };
export const draftKey = (member: string, ask: string) => `loom:inbox:draft:v1:${encodeURIComponent(member)}:${encodeURIComponent(ask)}`;
const validVersion = (value: string | null): value is string => !!value && /^[a-z2-7]{16}$/.test(value);
const versionKey = (key: string, version: string) => `${key}:${version}`;
export function readDraft(key: string): Draft {
  try {
    const version = localStorage.getItem(key);
    if (!validVersion(version)) return empty;
    const text = localStorage.getItem(versionKey(key, version));
    if (text !== null) return { version, text };
  } catch { /* A blocked or malformed device store must not break the editor. */ }
  return empty;
}
const same = (a: Draft, b: Draft) => a.version === b.version && a.text === b.text;
function store(key: string, value: Draft): boolean {
  try {
    const previous = localStorage.getItem(key);
    if (value.text) localStorage.setItem(versionKey(key, value.version), value.text);
    localStorage.setItem(key, value.version);
    if (validVersion(previous) && previous !== value.version) localStorage.removeItem(versionKey(key, previous));
    return true;
  } catch { return false; }
}
/** Mounted under a member+ask key. No draft words are sent until an explicit answer. */
export function useReplyDraft(member: string, ask: string): ReplyDraft {
  const key = draftKey(member, ask);
  const [value, setValue] = useState(() => readDraft(key));
  const [persistent, setPersistent] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const refresh = (event: StorageEvent) => { if (event.key === key || event.key?.startsWith(`${key}:`) || event.key === null) setValue(readDraft(key)); };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, [key]);
  return { value, persistent,
    edit(text) {
      const next = { version: newId(), text };
      setPersistent(store(key, next)); setValue(next);
    },
    acknowledged(sent) {
      // Never compare-and-delete the shared pointer: another window can write between them.
      // Immutable revision slots let an old acknowledgement delete only its sent words.
      try { localStorage.removeItem(versionKey(key, sent.version)); }
      catch { setPersistent(false); }
      setValue(current => same(current, sent) ? readDraft(key) : current);
    },
  };
}
