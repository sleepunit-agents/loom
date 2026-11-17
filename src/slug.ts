/**
 * The slug rule, once: lowercase letters and digits in runs joined by single dashes.
 *
 * The pattern is the same wherever something is named by a slug. The length is not, because the three
 * things it names are kept in different places; each cap is stated here with what it protects.
 */
import { z } from 'zod';

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
