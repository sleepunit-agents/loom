/** What every brick's definition is made from: the shape of a brick, the kinds of record it may name and the
 * shapes of their references. One definition per brick sits beside this file; ../bricks.ts lists them. */
import { z } from 'zod';

/** Record references are checked for shape only. Whether the record exists, and whether the member looking
 * may read it, is decided by the read that draws the brick. The shape is an id's: ASCII letters, digits and
 * the few marks loom's ids use, so a reference cannot carry a sentence, a look-alike letter or blank space
 * onto a board. The page shows a reference only in its small monospace line, never as a heading. */
export const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._\/@-]{0,119}$/);
export const ticket = z.string().regex(/^t-[1-9]\d*$/);
export const person = z.string().regex(/^(member|contact):[a-z0-9][a-z0-9._-]{0,99}$/);
/** A change's id as loom writes it (src/apps/changes.ts): `github:`, the repository as owner/repo in lower case,
 * `#` and the pull request's number. `#` is in no other reference. */
export const change = z.string().max(120).regex(/^github:[a-z0-9._-]+\/[a-z0-9._-]+#[1-9]\d*$/);

export const recordKinds = [
  'project', 'ticket', 'change', 'repository', 'person', 'agent', 'inbox item', 'approval', 'session',
  'knowledge page', 'knowledge topic', 'trigger',
] as const;
export type RecordKind = (typeof recordKinds)[number];

export interface Brick {
  name: string;
  shows: string;
  /** Strict: an unknown parameter is refused. Every parameter that is not a record reference has a default. */
  params: z.ZodObject;
  /** The parameters that are record references, and the kind of record each names. Only these can be left
   * open in a blueprint. */
  references: Record<string, RecordKind>;
  /** The parameter a chip's link key fills, for a brick that can be written in words. */
  linkKey?: string;
  /** Whether it has a primary form. Every brick has the small forms; only some can be the big one. */
  big: boolean;
  /** The changes to its own record the page marks it for, by name. The page raises these; nothing is stored. */
  flags: readonly string[];
  /** Action name → the schema of its detail, which holds only choices and ids. */
  actions: Record<string, { detail: z.ZodObject; operation: string }>;
}

export const none = z.object({}).strict();
export const brick = (b: Omit<Brick, 'big' | 'flags'> & Partial<Pick<Brick, 'big' | 'flags'>>): Brick => ({ big: false, flags: [], ...b });
