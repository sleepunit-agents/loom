// The thread as 000h's ledger, in plain words (views.tsx DashboardView): its own chunk, with the activity feed and the
// rules that read an agent's notes as what happened (thread-plain.ts), so neither weighs on the first page.
import { ActivityFeed } from '@/components/ui/activity-feed';
import { Badge } from '@/components/ui/badge';
import { Arrive } from './arrive';
import { Link, Nothing, useEnv } from './blocks';
import { clockOf, dayOf, plainThread } from './thread-plain';
import { tidy } from './tidy';

type ThreadRow = { agent?: string; text: string; meta?: string; where?: string; at?: string; page?: string };

/** An agent's mark as a picture (for a component that takes an image, like the activity feed's avatar): its initial on its colour. */
const markImage = (a: { label: string; bg: string; fg: string }) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="${a.bg}"/><text x="32" y="43" text-anchor="middle" font-family="Bricolage Grotesque, DM Sans, system-ui, sans-serif" font-size="30" font-weight="600" fill="${a.fg}">${a.label[0].replace(/[<&>"]/g, '')}</text></svg>`)}`;

// Where a thread row happened, as its chip's colour: a chat by its service, a wake or a lane by itself.
const WHERE_TONE = (w: string): 'blue-soft' | 'olive-soft' | 'pink-soft' | 'yellow-soft' | 'cream' =>
  /^Discord/.test(w) ? 'blue-soft' : /^Slack/.test(w) ? 'olive-soft' : /^Lane/.test(w) ? 'yellow-soft' : /^Wake/.test(w) ? 'pink-soft' : 'cream';

export default function Ledger({ rows, title, now }: { rows: ThreadRow[]; title: string; now: number }) {
  const { ctx } = useEnv();
  return (
    <>
        {/* 000h's ledger (Jonathan, 2026-10-30): an agent's run of entries under one mark, the time at the right, a day's
            heading where it changes; each row in plain words (thread-plain.ts), where it happened as its chip, and the
            bookkeeping (the task, the round, the lane) as small chips under it. */}
        <ActivityFeed variant="ledger" title={title} initialVisible={16} pageSize={16} showMoreLabel="Earlier"
          empty={<Nothing title="Quiet" text="Nothing on the thread yet today." />}
          entries={rows.map((r) => {
            const p = plainThread(r.text);
            const where = r.where ?? r.meta?.split(' · ')[0];
            return {
              id: `${r.at}\0${r.text}`,
              title: <Arrive as="span" k={`th:${r.at}\0${r.text}`}><Link page={r.page} className="no-underline hover:underline">{tidy(p.title)}</Link></Arrive>,
              ...(p.detail ? { description: tidy(p.detail) } : {}),
              // The feed's avatar wears the agent's own mark (its colour, its initial), so who did what reads at a glance.
              ...(r.agent && ctx.agents?.[r.agent] ? { actor: { name: ctx.agents[r.agent].label, initials: ctx.agents[r.agent].label[0], avatarSrc: markImage(ctx.agents[r.agent]) } } : {}),
              ...(r.at ? { timestamp: clockOf(r.at), dateTime: r.at, group: dayOf(r.at, now) } : {}),
              // Where it happened, when that says something: a chat, a lane, a session (a plain wake is most rows: no chip).
              ...(where && where !== 'Wake' ? { badge: { label: where, variant: WHERE_TONE(where) } } : {}),
              ...(p.chips.length ? { content: <span className="flex flex-wrap gap-1.5">{p.chips.map((c) => (
                <Badge key={c.label} size="sm" variant="dashed">{c.page ? <Link page={c.page} className="no-underline">{c.label}</Link> : c.label}</Badge>
              ))}</span> } : {}),
            };
          })} />
    </>
  );
}
