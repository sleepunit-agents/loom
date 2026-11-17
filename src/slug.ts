/**
 * The slug rule, once: lowercase letters and digits in runs joined by single dashes.
 *
 * The pattern is the same wherever something is named by a slug. The length is not, because the three
 * things it names are kept in different places; each cap is stated here with what it protects.
 */
import { z } from 'zod';

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** The same rule for use inside a longer pattern: no anchors and no capture. */
export const SLUG_WITHIN = '[a-z0-9]+(?:-[a-z0-9]+)*';

/** A member, an agent or a household project: a key in the household database and a segment of the app's
 * addresses. The cap only bounds what a form or a command may send. */
export const HOUSEHOLD_ID_MAX = 100;
/** A person card in an agent's memory (docs/specs/person-cards.md): the card's key and the name it is rendered under. */
export const PERSON_CARD_SLUG_MAX = 64;
/** A project card in an agent's memory (docs/specs/projects.md): at most 32, so that the card's name as a
 * field name (`-` to `_`) fits the 32 characters a card's field name may have. A household project's id may
 * be longer than this; such a project cannot have a card under its own id. */
export const PROJECT_CARD_SLUG_MAX = 32;

export const slug = (max: number) => z.string().regex(SLUG).max(max);
/** The id of a member, an agent or a household project. */
export const householdId = slug(HOUSEHOLD_ID_MAX);

/** The name of one of an agent's identity pages or manifests: letters, digits and . _ - , at most 100. */
export const PAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** The id a memory store gives a memory, a draft or a card: 36 characters of hex and dashes. */
export const STORE_ID = /^[a-f0-9-]{36}$/;
/** An id as the doors give it: the agent it belongs to, a colon, for a draft or a card its kind and a colon,
 * and the store's own id. */
export const scopedStoreId = (kind?: string) => new RegExp(`^[^:]+:${kind ? `(?:${kind}):` : ''}${STORE_ID.source.slice(1, -1)}$`);
/** A memory's id as the doors give it. */
export const SCOPED_MEMORY_ID = scopedStoreId();

/** A task's id: `t-` and its number, counted up by the Tasks app (`taskId`, used where a task is made).
 * This is source text for building a larger pattern, like SLUG_WITHIN; every place that finds a task
 * id in words builds on it, so none can disagree about how long a number may be. */
export const TASK_ID = 't-[0-9]+';
export const taskId = (n: number | string) => `t-${n}`;
/** A conversation's id: `cv-` and a UUID (`conversationId`, used where a conversation is opened), or the
 * twelve hex digits an earlier program gave, which an older home's episodes still name. Source text. */
export const CONVERSATION_ID = 'cv-(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{12})';
export const conversationId = (uuid: string) => `cv-${uuid}`;
