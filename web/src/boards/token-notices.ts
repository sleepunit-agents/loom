/** What the member must be told about a token asked for from a `household` brick when the brick could not say it
 * itself: its fate unknown (no reply, a 5xx, a 2xx whose body cannot be read), or made after the form that asked
 * went away so its value can never be shown. Kept here, outside every component, so it outlives the brick's body
 * (folded, removed, another board shown, the brick drawn small). The board's header row says it, once, on whatever
 * board is shown (./board-head.tsx); a household brick's read of the token list is what ends one of unknown fate.
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
  // One notice for one label and kind whose fate is unknown, however often it was asked for; and no more than eight.
  const same = notices.find((n) => n.fate === 'unknown' && notice.fate === 'unknown' && n.label === notice.label && n.kind === notice.kind);
  if (same) return same.id;
  const id = ++next;
  change([...notices, { ...notice, id }].slice(-8));
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
/** How the household brick names a kind of token (its "For" choices), so a notice reads as the form did. */
export const tokenKindWords: Readonly<Record<string, string>> = { member: 'Household member', agent: 'Agent', machine: 'Machine', program: 'Outside program' };
const kindWords = (kind: string) => tokenKindWords[kind] ?? kind;
/** A notice in full: a token that may have been made, or one made whose value cannot be shown. Its label and kind, never a value. */
export const noticeWords = (notice: TokenNotice) => (notice.fate === 'unknown'
  ? `Token creation for “${notice.label}” (${kindWords(notice.kind)}) may have completed. Check its label in the token list and revoke it before trying again.`
  : `Token “${notice.label}” (${kindWords(notice.kind)}) was made after its form went away, so its value cannot be shown. Revoke it if you did not save it, and make another.`);
/** The same notice in a few words, for the board's header row. */
export const noticeBrief = (notice: TokenNotice) => (notice.fate === 'unknown' ? `Token “${notice.label}” may have been made` : `Token “${notice.label}”: its value is lost`);

/** For tests: a new page. */
export function forgetTokenNotices() { change([]); }

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => notices;
export const useTokenNotices = () => useSyncExternalStore(subscribe, read, read);
