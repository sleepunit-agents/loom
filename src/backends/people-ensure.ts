/**
 * Ensure a person card exists (docs/specs/person-cards.md, "Ensure"): the one seam
 * through which adding a person anywhere outside an agent's own tools (a piece
 * letting someone into an agent's gates, the runtime, the owner by hand) makes
 * their card, so a person is one card, not one per list that knows them.
 *
 *   no card      create a minimal one: the name, a one-line summary from the role
 *                and the source, and the `where` values given
 *   a card       only add the `where` values it lacks, as `loom person reach` does:
 *                name, summary, how and may are never touched
 *
 * A `where` value already on another card is refused: one person, one card. The
 * caller's authority is checked where it arrives (the CLI and the HTTP route);
 * this module only plans and writes.
 */
import {
  PeopleStore, PersonCardError, personSlugError, RESERVED_KEYS,
  type CardValue, type PersonCard, type PersonWriteInput, type WhereEnvelope,
} from './people.js';
import { HouseholdPeople } from './people-household.js';
import { isReserved, checkFieldName, isPlainObject } from './cards.js';

const MAX_STRING = 200;
const MAX_NAME = 80;
const MAX_ROLE = 200;
const MAX_FIELDS = 12;
const MAX_VALUES = 8;
const INPUT_KEYS = ['slug', 'name', 'role', 'source', 'where', 'agent', 'dry_run'];
const WHERE_KEYS = ['value', 'label', 'source'];

export interface EnsureWhere {
  /** One id or address, or several: each is added if the card lacks it. */
  value: string | string[];
  /** What a person reads for it ("@sleepunit"), set only when the field has none. */
  label?: string;
  /** Where it came from; defaults to the call's `source`. */
  source?: string;
}

export interface EnsureInput {
  slug: string;
  name: string;
  /** A few words on who they are: the summary's first part, on a new card only. */
  role?: string;
  /** Who added them, from where: "shuttle gates (art's people), allowed by the owner 2026-11-02". */
  source: string;
  where?: Record<string, EnsureWhere>;
  /** In a household, the agent whose relationship holds a new card's summary (the household's default otherwise). */
  agent?: string;
  /** Plan only: say what would change, write nothing. */
  dry_run?: boolean;
}

export interface EnsureResult {
  slug: string;
  /** True when there was no card and this made one (or, dry, would). */
  created: boolean;
  /** The values added, by field (all of them on a create). */
  added: Record<string, string[]>;
  /** Nothing to do: the card has every value given. */
  unchanged: boolean;
  dry_run: boolean;
  /** The card as it is now (as it would be, dry). */
  card: PersonCard;
  /** The slug the call named, when it was merged into `slug` (person_merge): the values landed there. */
  redirected_from?: string;
}

const str = (v: unknown, path: string, max: number, required = true): string | undefined => {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || v.trim() === '') throw new PersonCardError(`${path}: is required text`);
  if (v.length > max) throw new PersonCardError(`${path}: is ${max} characters at most`);
  if (/[\r\n]/.test(v)) throw new PersonCardError(`${path}: is one line`);
  return v.trim();
};

/** The input, checked: unknown keys, a bad slug, a reserved or malformed field name, long or empty text all refuse. */
export function checkEnsureInput(body: unknown): EnsureInput {
  if (!isPlainObject(body)) throw new PersonCardError('input: is a JSON object');
  for (const k of Object.keys(body)) if (!INPUT_KEYS.includes(k)) throw new PersonCardError(`${k}: unknown key (allowed: ${INPUT_KEYS.join(', ')})`);
  const slugErr = personSlugError(body.slug);
  if (slugErr) throw new PersonCardError(`slug: ${slugErr}`);
  const out: EnsureInput = {
    slug: body.slug as string,
    name: str(body.name, 'name', MAX_NAME)!,
    source: str(body.source, 'source', MAX_STRING)!,
  };
  const role = str(body.role, 'role', MAX_ROLE, false);
  if (role) out.role = role;
  if (body.agent !== undefined) {
    if (typeof body.agent !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(body.agent)) throw new PersonCardError('agent: is an agent\'s name');
    out.agent = body.agent;
  }
  if (body.dry_run !== undefined) {
    if (typeof body.dry_run !== 'boolean') throw new PersonCardError('dry_run: is true or false');
    out.dry_run = body.dry_run;
  }
  if (body.where !== undefined) {
    if (!isPlainObject(body.where)) throw new PersonCardError('where: maps a field to {value, label?, source?}');
    const fields = Object.keys(body.where);
    if (fields.length > MAX_FIELDS) throw new PersonCardError(`where: ${MAX_FIELDS} fields at most`);
    out.where = {};
    for (const f of fields) {
      if (isReserved(f)) {
        throw new PersonCardError(`where.${f}: "${f}" is a reserved key (harness gating names: ${RESERVED_KEYS.join(', ')}). ` +
          'A card is not an authorization surface; gates stay in the harness.');
      }
      checkFieldName(f, `where.${f}`);
      const e = body.where[f];
      if (!isPlainObject(e)) throw new PersonCardError(`where.${f}: is {value, label?, source?}`);
      for (const k of Object.keys(e)) {
        if (isReserved(k)) throw new PersonCardError(`where.${f}.${k}: "${k}" is a reserved key (harness gating names: ${RESERVED_KEYS.join(', ')})`);
        if (!WHERE_KEYS.includes(k)) throw new PersonCardError(`where.${f}.${k}: unknown key (allowed: ${WHERE_KEYS.join(', ')})`);
      }
      const values = Array.isArray(e.value) ? e.value : [e.value];
      if (values.length === 0 || values.length > MAX_VALUES) throw new PersonCardError(`where.${f}.value: 1 to ${MAX_VALUES} values`);
      const vs = values.map((v, i) => str(v, `where.${f}.value${Array.isArray(e.value) ? `[${i}]` : ''}`, MAX_STRING)!);
      const label = str(e.label, `where.${f}.label`, MAX_STRING, false);
      const source = str(e.source, `where.${f}.source`, MAX_STRING, false);
      out.where[f] = { value: vs.length === 1 && !Array.isArray(e.value) ? vs[0] : vs, ...(label ? { label } : {}), ...(source ? { source } : {}) };
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A value's id: its first word ("U08C330F8AG (Onterris)" → "U08C330F8AG"). */
export const idOf = (value: string): string => value.trim().split(/\s+/)[0];

/**
 * Whether `value` is already among `there`. A value written by hand may be a note around
 * the id ("U02AYL3QX (Onterris), DM D0…"): the id in it counts as there. `loom person reach`
 * uses the same test.
 */
export function holdsValue(there: readonly string[], value: string): boolean {
  const id = idOf(value);
  const word = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(id)}([^A-Za-z0-9]|$)`);
  return there.some((v) => v === value || word.test(v));
}

export const valuesOf = (e: WhereEnvelope | undefined): string[] =>
  e === undefined ? [] : Array.isArray(e.value) ? e.value.map(String) : [String(e.value)];

/** The summary a new card gets: "<role>. From <source>." */
export function ensureSummary(role: string | undefined, source: string): string {
  const r = role?.trim().replace(/[.\s]+$/, '');
  return r ? `${r}. From ${source}.` : `From ${source}.`;
}

type Store = PeopleStore | HouseholdPeople;

/** Any other card (archived ones too: still that person) holding one of `values` in `field` (by id): the first, or null. */
function heldElsewhere(store: Store, slug: string, field: string, values: string[]): { slug: string; value: string } | null {
  for (const e of store.list(true)) {
    // A merged card's values are its survivor's now (person_merge): it's a redirect, not another person.
    if (e.slug === slug || e.merged_into !== undefined) continue;
    let row;
    try { row = store.getRow(e.slug); } catch { continue; }
    if (!row) continue;
    const there = valuesOf(row.card.where?.[field]);
    for (const v of values) if (holdsValue(there, v)) return { slug: e.slug, value: v };
  }
  return null;
}

/** Make sure `input.slug` has a card, adding only what it lacks. Throws PersonCardError with the reason. */
export function ensurePerson(store: Store, input: EnsureInput): EnsureResult {
  // A merged slug is a redirect: an ensure of it adds to the card it was merged into.
  const asked = input.slug;
  const target = store.resolve(asked);
  if (target !== asked) return { ...ensurePerson(store, { ...input, slug: target }), redirected_from: asked };
  const dry = input.dry_run === true;
  const row = store.getRow(input.slug);
  if (row?.archived_at) throw new PersonCardError(`card for ${input.slug} is archived; restore it (person_restore) before adding to it`);
  const where = input.where ?? {};

  // One person, one card: no value given here may already be someone else's.
  for (const [f, e] of Object.entries(where)) {
    const other = heldElsewhere(store, input.slug, f, Array.isArray(e.value) ? e.value : [e.value]);
    if (other) throw new PersonCardError(`where.${f}: ${idOf(other.value)} is already on ${other.slug}'s card; one person is one card`);
  }

  if (!row) {
    const card: PersonWriteInput = {
      slug: input.slug, name: input.name, summary: ensureSummary(input.role, input.source),
      where: Object.fromEntries(Object.entries(where).map(([f, e]) => [f, {
        value: e.value as CardValue, source: e.source ?? input.source, ...(e.label ? { label: e.label } : {}),
      }])),
    };
    const added = Object.fromEntries(Object.entries(where).map(([f, e]) => [f, Array.isArray(e.value) ? e.value : [e.value]]));
    if (dry) return { slug: input.slug, created: true, added, unchanged: false, dry_run: true, card: { ...card, how: {}, may: [] } as PersonCard };
    const out = store.write(card);
    return { slug: input.slug, created: true, added, unchanged: false, dry_run: false, card: out.card };
  }

  // A card: each field gets the values it lacks, kept beside the ones there, never in their place.
  const next: Record<string, WhereEnvelope> = {};
  const added: Record<string, string[]> = {};
  for (const [f, e] of Object.entries(where)) {
    const was = row.card.where?.[f];
    const there = valuesOf(was);
    const missing = (Array.isArray(e.value) ? e.value : [e.value]).filter((v, i, all) => !holdsValue(there, v) && all.indexOf(v) === i);
    if (!missing.length) continue;
    const values = [...there, ...missing];
    added[f] = missing;
    next[f] = {
      ...(was ?? {}),
      value: values.length === 1 ? values[0] : values,
      ...(was?.label ? {} : e.label ? { label: e.label } : {}),
      source: was?.source ?? e.source ?? input.source,
    };
  }
  if (!Object.keys(next).length) return { slug: input.slug, created: false, added: {}, unchanged: true, dry_run: dry, card: row.card };
  if (dry) return { slug: input.slug, created: false, added, unchanged: false, dry_run: true, card: { ...row.card, where: { ...row.card.where, ...next } } };
  const out = store instanceof HouseholdPeople ? store.writeWhere(input.slug, next) : store.write({ slug: input.slug, where: next });
  return { slug: input.slug, created: false, added, unchanged: false, dry_run: false, card: out.card };
}
