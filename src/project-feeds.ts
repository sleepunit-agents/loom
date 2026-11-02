/**
 * Project section feeds (docs/specs/projects.md, "Section feeds (the seam)"):
 * every installed managed piece offering `sections.project`, run for one
 * project through the offers runner (src/offers-registry.ts, runOffer), its
 * answer checked by `parseFeed`, keyed `piece:<name>`.
 *
 * The arguments, in this order: `--project <slug> --since <iso>`, then
 * `--epic <id>` when the card has one, `--name <alias>` for each alias and
 * `--venue <v>` for each venue, each in the card's order. `since` is clamped
 * to 8 days ago (a longer one still reaches the core sections) and passed as
 * UTC `YYYY-MM-DDTHH:MM:SSZ`. Every failure (a non-zero exit, a timeout, an
 * answer that isn't valid) is that piece's `{key, error}` alone.
 *
 * Only a managed piece is ever run: one found on PATH has no piece.json, so
 * `piecesOffering` never lists it.
 */
import { piecesOffering, runOffer } from './offers-registry.js';
import { parseFeed, type FeedGroup } from './offers.js';
import type { ProjectCard } from './backends/projects.js';

const DAY_MS = 86_400_000;
/** Feeds get at most 8 days, so a day-grouped feed never needs more than 8 groups. */
export const FEED_MAX_SINCE_DAYS = 8;
/** Home's Unfiled list asks for the last 7 days. */
export const UNFILED_SINCE_DAYS = 7;

export type FeedSection = { key: string; label: string; groups: FeedGroup[] } | { key: string; error: string };

/** A time as UTC to the second, `YYYY-MM-DDTHH:MM:SSZ`, rounded up so a clamp never reaches past its bound. */
export function feedTime(ms: number): string {
  return new Date(Math.ceil(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The feed's `since`: the hub's, but no earlier than 8 days before now. */
export function feedSince(since: string, nowMs: number): string {
  return feedTime(Math.max(Date.parse(since), nowMs - FEED_MAX_SINCE_DAYS * DAY_MS));
}

/** The arguments a feed is run with for `card`, in the documented order. */
export function feedArgs(card: Pick<ProjectCard, 'slug' | 'links'>, since: string, nowMs: number): string[] {
  const args = ['--project', card.slug, '--since', feedSince(since, nowMs)];
  if (card.links?.epic) args.push('--epic', card.links.epic);
  for (const n of card.links?.aliases ?? []) args.push('--name', n);
  for (const v of card.links?.venues ?? []) args.push('--venue', v);
  return args;
}

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

async function runFeeds(env: NodeJS.ProcessEnv, args: string[], only?: (p: { unfiled: boolean }) => boolean): Promise<FeedSection[]> {
  const pieces = piecesOffering(env, 'sections').filter((p) => p.offers.sections && (!only || only(p.offers.sections.project)));
  // runOffer's pool keeps it to 6 at once; never throws.
  const out = await Promise.all(
    pieces.map(async ({ piece, offers }): Promise<FeedSection> => {
      const { label, argv } = offers.sections!.project;
      const key = `piece:${piece}`;
      try {
        const r = await runOffer(env, piece, argv, { args, parse: parseFeed });
        return r.ok ? { key, label, groups: r.value.groups } : { key, error: r.error };
      } catch (e) {
        return { key, error: (e as Error).message ?? String(e) };
      }
    }),
  );
  return out.sort(byKey);
}

/**
 * The hub's piece sections: a `PieceSectionSource` (src/tools/project.ts) over
 * the managed pieces installed under `env`'s LOOM_HOME.
 */
export function managedPieceSections(env: NodeJS.ProcessEnv = process.env) {
  return async ({ card, since, nowMs }: { card: ProjectCard; since: string; nowMs?: number }): Promise<FeedSection[]> =>
    runFeeds(env, feedArgs(card, since, nowMs ?? Date.now()));
}

/**
 * Home's "Unfiled" list: every feed that declares `unfiled: true`, asked
 * `--unfiled --since <7 days ago>`, keyed as the hub's sections.
 */
export async function unfiledSections(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): Promise<FeedSection[]> {
  return runFeeds(env, ['--unfiled', '--since', feedTime(nowMs - UNFILED_SINCE_DAYS * DAY_MS)], (p) => p.unfiled);
}
