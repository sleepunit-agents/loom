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
export function readDraft(key: string): Draft {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && typeof value === 'object' && 'version' in value && typeof value.version === 'string' && value.version.length > 0 && 'text' in value && typeof value.text === 'string') return { version: value.version, text: value.text };
  } catch { /* A blocked or malformed device store must not break the editor. */ }
  return empty;
}
const same = (a: Draft, b: Draft) => a.version === b.version && a.text === b.text;
function store(key: string, value: Draft): boolean {
  try { if (value.text) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); return true; }
  catch { return false; }
}
/** Mounted under a member+ask key. No draft words are sent until an explicit answer. */
export function useReplyDraft(member: string, ask: string): ReplyDraft {
  const key = draftKey(member, ask);
  const [value, setValue] = useState(() => readDraft(key));
  const [persistent, setPersistent] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const refresh = (event: StorageEvent) => { if (event.key === key || event.key === null) setValue(readDraft(key)); };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, [key]);
  return { value, persistent,
    edit(text) {
      const next = { version: newId(), text };
      setPersistent(store(key, next)); setValue(next);
    },
    acknowledged(sent) {
      // Compare against the current device value, including edits from another window.
      const stored = readDraft(key);
      if (same(stored, sent)) setPersistent(store(key, empty));
      setValue(current => same(current, sent) ? (same(stored, sent) ? empty : stored) : current);
    },
  };
}
