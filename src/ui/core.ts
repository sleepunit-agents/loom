/**
 * loom's own sections for the UI: what only loom knows. Read-only views over
 * the stores (top of mind, the episode tape, pending proposals, people),
 * assembled from the same functions the identity payload and the MCP-App
 * widgets use. Nothing here writes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestData } from '../backends/salience.js';
import { episodeRows, tapeClock } from '../backends/episodes.js';
import { listProposals } from '../backends/proposals.js';
import { listPeople } from '../tools/person.js';
import type { Section, Tone } from './sections.js';

const TOP_OF_MIND = 12;
const TAPE_HOURS = 24;
const TAPE_SHOWN = 20;

function whereOf(metadata: string, project: string | null): string {
  try {
    const meta = JSON.parse(metadata || '{}') as Record<string, unknown>;
    if (typeof meta.where === 'string' && meta.where.trim()) return meta.where.trim();
  } catch { /* fall through */ }
  return project?.trim() || '?';
}

function tierTone(tier: string): Tone | undefined {
  return tier === 'cold' ? 'muted' : undefined;
}

/** The agent's name: IDENTITY.md's first heading, else the context dir's name. */
export function agentName(contextDir: string): string {
  try {
    const line = readFileSync(join(contextDir, 'IDENTITY.md'), 'utf-8').split('\n').find((l) => /^#\s+\S/.test(l));
    if (line) return line.replace(/^#\s+/, '').trim();
  } catch { /* no identity file */ }
  return contextDir.split('/').filter(Boolean).pop() ?? 'loom';
}

export function coreSections(contextDir: string, opts: { timeZone?: string; nowMs?: number } = {}): Section[] {
  const timeZone = opts.timeZone ?? process.env.TZ ?? 'America/Chicago';
  const digest = digestData(contextDir, TOP_OF_MIND);
  const episodes = episodeRows(contextDir, { hours: TAPE_HOURS, nowMs: opts.nowMs });
  const pending = listProposals(contextDir).filter((p) => p.status === 'pending');
  const people = listPeople(contextDir);

  const sections: Section[] = [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [{
        type: 'stats',
        items: [
          { label: 'memories', value: String(digest?.total ?? 0) },
          { label: `episodes, last ${TAPE_HOURS}h`, value: String(episodes.length) },
          { label: 'proposals pending', value: String(pending.length), tone: pending.length ? 'warn' : undefined },
          { label: 'people', value: String(people.length) },
        ],
      }],
    },
    {
      id: 'tape',
      title: `Last ${TAPE_HOURS}h`,
      blocks: episodes.length
        ? [
            {
              type: 'list',
              items: [...episodes].reverse().slice(0, TAPE_SHOWN).map((e) => ({
                text: e.title,
                meta: `${tapeClock(e.created, timeZone)} · ${whereOf(e.metadata, e.project)}`,
              })),
            },
            ...(episodes.length > TAPE_SHOWN
              ? [{ type: 'text' as const, text: `and ${episodes.length - TAPE_SHOWN} earlier` }]
              : []),
          ]
        : [{ type: 'text', text: 'No episodes in the last day.' }],
    },
    {
      id: 'top-of-mind',
      title: 'Top of mind',
      blocks: digest && digest.atoms.length
        ? [{
            type: 'list',
            items: digest.atoms.map((a) => ({ text: a.title, meta: `${a.category} · ${a.tier}`, tone: tierTone(a.tier) })),
          }]
        : [{ type: 'text', text: 'Nothing hot yet.' }],
    },
  ];

  if (pending.length) {
    sections.push({
      id: 'proposals',
      title: 'Proposals waiting',
      blocks: [{
        type: 'list',
        items: pending.map((p) => ({
          text: p.title ?? '(untitled)',
          meta: `#${p.id} · ${p.category ?? '?'}${p.source ? ` · ${p.source}` : ''}`,
          tone: 'warn',
        })),
      }],
    });
  }

  if (people.length) {
    // Only the cards that need a look: stale or unverified fields, or memories
    // written since the summary was last synthesized.
    const attention = people.filter((p) => p.stale || p.unverified || p.memories_since_synthesis);
    sections.push({
      id: 'people',
      title: 'People',
      blocks: [
        {
          type: 'stats',
          items: [
            { label: 'cards', value: String(people.length) },
            { label: 'need a look', value: String(attention.length), tone: attention.length ? 'warn' : 'ok' },
          ],
        },
        attention.length
          ? {
              type: 'table',
              columns: ['name', 'stale', 'unverified', 'new memories'],
              rows: attention.map((p) => [p.name, String(p.stale), String(p.unverified), String(p.memories_since_synthesis)]),
            }
          : { type: 'text', text: 'Every card is fresh.' },
      ],
    });
  }
  return sections;
}
