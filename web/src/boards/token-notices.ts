/** What the member must be told about a token asked for from a `household` brick when the brick could not say it
 * itself: its fate unknown (no reply, a 5xx, a 2xx whose body cannot be read), or made after the form that asked
 * went away so its value can never be shown. Kept here, outside every component, so it outlives the brick's body
 * (folded, removed, another board shown, the brick drawn small): any household brick drawn afterwards shows it.
 *
 * In memory only, for the page's life: never storage, the address or a log. A notice holds a token's label and
 * kind, never its value; and, for a notice of unknown fate, how many tokens of that label the list held when it was
 * asked for (`had`), so that the same label seen anew in the token list ends it. A member dismisses any notice. */
import { useSyncExternalStore } from 'react';

export type Fate = 'unknown' | 'made';
export type TokenNotice = { readonly id: number; readonly label: string; readonly kind: string; readonly fate: Fate; readonly had: number };

let notices: readonly TokenNotice[] = [];
let next = 0;
const listeners = new Set<() => void>();
const change = (to: readonly TokenNotice[]) => { notices = to; for (const listener of listeners) listener(); };

/** A notice for a token asked for; its id, to change or end it when loom's late answer comes. */
export function addTokenNotice(notice: Omit<TokenNotice, 'id'>): number {
  const id = ++next;
  change([...notices, { ...notice, id }]);
  return id;
}
/** loom's late answer: made (the value is lost), or refused (nothing was made, so the notice ends). */
export function settleTokenNotice(id: number, answer: 'made' | 'refused') {
  if (!notices.some((n) => n.id === id)) return;
  change(answer === 'refused' ? notices.filter((n) => n.id !== id) : notices.map((n) => (n.id === id ? { ...n, fate: 'made' } : n)));
}
export function dismissTokenNotice(id: number) {
  if (notices.some((n) => n.id === id)) change(notices.filter((n) => n.id !== id));
}
/** A notice of unknown fate ends when the token list holds more tokens of its label than when it was asked for. */
export function seenTokenLabels(count: (label: string) => number) {
  const left = notices.filter((n) => n.fate !== 'unknown' || count(n.label) <= n.had);
  if (left.length !== notices.length) change(left);
}
/** For tests: a new page. */
export function forgetTokenNotices() { change([]); }

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => notices;
export const useTokenNotices = () => useSyncExternalStore(subscribe, read, read);
