/** What every brick's module shares (docs/specs/boards.md, "The first bricks"): the types of a brick's body, the two
 * one-line states, the chip that places another brick, and the watch a brick keeps on its own record. A brick's
 * module imports this file and never another brick's module, so each brick is loaded alone (./bricks.tsx). */
import { useEffect, useRef, type ReactNode } from 'react';
import { knowledgePageRef } from '../../../src/core/boards/refs';
import type { Form } from './layout';

export type Params = Record<string, string | number | undefined>;
export type Place = { brick: string; params: Params };
/** Report a brick's action after its own operation succeeded. */
export type Act = (action: string, detail: Record<string, string>) => void;
/** Mark this placement: its record changed in a way the brick flags itself for, and the member did not do it. */
export type Raise = (name: string) => void;
export type BodyProps = { params: Params; form: Form; act: Act; raise: Raise };

/** Watches one value of a brick's record. When it changes while the page is open, and the change was not the
 * member's own doing here a moment ago, the brick flags itself with the name the change is given. */
export function useOwnFlag<T>(value: T | undefined, raise: Raise, name: (before: T, now: T) => string | null) {
  const before = useRef<T | undefined>(undefined), mine = useRef(0);
  useEffect(() => {
    const was = before.current;
    before.current = value;
    if (was === undefined || value === undefined || was === value) return;
    if (Date.now() - mine.current < 5000) { mine.current = 0; return; }
    const called = name(was, value);
    if (called) raise(called);
  });
  return () => { mine.current = Date.now(); };
}

export const words = (v: unknown) => (v === undefined || v === null ? '' : String(v));
export const Unavailable = ({ what }: { what: string }) => <p className="text-muted-foreground">This {what} is unavailable.</p>;
export const Loading = () => <p role="status" className="text-muted-foreground">Loading…</p>;

/** A reference to another brick's record. Clicking it places that brick, at once, with no job. */
export function Chip({ place, children }: { place: Place; children: ReactNode }) {
  return (
    <button type="button" className="board-chip" data-place={JSON.stringify(place)}>
      <i aria-hidden="true" />
      {children}
    </button>
  );
}
export const ticketChip = (id: string) => <Chip place={{ brick: 'ticket', params: { ticket: id } }}><span className="font-mono">{id}</span></Chip>;
export function actorChip(kind: string | null | undefined, id: string) {
  return kind === 'agent'
    ? <Chip place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip>
    : <Chip place={{ brick: 'person', params: { person: 'member:' + id } }}>{id}</Chip>;
}
/** A chip for a knowledge page, or its words alone when its slug is not one a board can hold. */
export const pageChip = (slug: string, label: string) => knowledgePageRef.test(slug)
  ? <Chip key={slug} place={{ brick: 'knowledge-page', params: { page: slug } }}>{label}</Chip> : <span key={slug}>{label}</span>;
/** How `changes.repository` is written (src/pieces/changes/model.ts, repositoryKey): owner/repo in lower case,
 * with no leading `github:` and no trailing `.git`. */
export const repositoryKey = (raw: string) => (raw.startsWith('github:') ? raw.slice(7) : raw).toLowerCase().replace(/\.git$/, '');
