/**
 * A person's where, for a page (the household's entry and an agent's own view of them): the ways to reach them as a
 * list in words (Jonathan, 2026-10-29: "on where to reach them, lets humanize that"), and any other where field (their
 * role on pond) as a fact.
 */
import { fieldState, type CardValue, type WhereEnvelope } from '../backends/people.js';
import type { Block, Section } from './vocab.js';

export const SERVICE: Record<string, string> = {
  discord: 'Discord', slack: 'Slack', email: 'Email', phone: 'Phone', github: 'GitHub', telegram: 'Telegram', signal: 'Signal',
  sms: 'SMS', matrix: 'Matrix', teams: 'Teams', whatsapp: 'WhatsApp',
};

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const cap = (k: string) => k.replace(/^./, (c) => c.toUpperCase());

/**
 * Reach (a section, or none) and the rest of where as facts. `value` and `ago` are the page's own: how a card value
 * reads, and how long ago a check was.
 */
export function reachOf(
  where: Record<string, WhereEnvelope> | undefined,
  value: (v: CardValue) => string,
  ago: (iso: string | null) => string,
  nowMs: number,
): { reach?: Section; facts: Array<{ label: string; value: string }> } {
  const all = Object.entries(where ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const ways = all.filter(([k]) => k in SERVICE);
  const facts = all.filter(([k]) => !(k in SERVICE)).map(([k, env]) => ({ label: cap(k), value: value(env.value) }));
  if (!ways.length) return { facts };
  const blocks: Block[] = [
    { type: 'list', items: ways.map(([k, env]) => {
      const st = fieldState(env, nowMs);
      const id = typeof env.value === 'string' ? env.value : '';
      const profile = k === 'discord' && /^\d{5,25}$/.test(id) ? `https://discord.com/users/${id}` : undefined;
      return {
        text: env.label ? oneLine(env.label) : value(env.value),
        meta: [SERVICE[k], st.kind === 'stale' ? `not checked in ${st.days} days` : st.kind === 'ok' ? '' : 'not checked'].filter(Boolean).join(' · '),
        ...(st.kind === 'ok' ? {} : { tone: 'warn' as const }),
        ...(profile ? { href: profile } : {}),
      };
    }) },
    { type: 'details', summary: 'Where this came from', blocks: [{
      type: 'table', columns: ['where', 'id', 'from', 'checked'],
      rows: ways.map(([k, env]) => {
        const st = fieldState(env, nowMs);
        return [SERVICE[k], value(env.value), env.source ?? '', st.kind === 'ok' ? `ok, ${ago(env.verified_at ?? null)}` : st.kind === 'stale' ? `stale ${st.days}d` : 'unverified'];
      }),
    }] },
  ];
  return { reach: { id: 'reach', title: 'Reach', blocks }, facts };
}
