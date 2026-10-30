// Someone, as a profile (Jonathan, 2026-10-29: 000h's profile card "might be rad to do here, presenting it that way").
// 000h's own ProfileCard is a showcase with its numbers and buttons fixed, so this is that card rebuilt from the same
// parts (Card, Avatar, Shape, Badge, Meta) around what loom knows: a cover in their colour with the signature shapes,
// their avatar over it, name and summary, what they are, a few numbers, and the ways out.
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Shape } from '@/components/ui/shape';
import { Meta } from '@/components/ui/typography';
import { AgentAvatar, Link, useEnv } from './blocks';
import type { Block } from './loom';

type P = Extract<Block, { type: 'profile' }>;
const SHAPES: Record<NonNullable<P['tone']>, [string, string, string]> = {
  pink: ['daisy-12', 'ribbon-soft', 'clover-soft'],
  yellow: ['sunburst-24', 'pebble-soft', 'petal-7'],
  olive: ['aster-9', 'cloud-3', 'seed-wing'],
  blue: ['scalloped-square', 'cushion', 'pebble-tall'],
};

export default function Profile({ p }: { p: P }) {
  const { ctx } = useEnv();
  const agent = p.agent ? ctx.agents?.[p.agent] : undefined;
  const tone = p.tone ?? 'blue';
  const [a, b, c] = SHAPES[tone];
  return (
    <Card className="loom-profile relative min-w-0 overflow-hidden p-0">
      <div className={`loom-profile__cover -${tone}`} style={agent ? ({ '--cover': agent.bg } as React.CSSProperties) : undefined} aria-hidden>
        <Shape name={a} className="loom-profile__shape -a" /><Shape name={b} className="loom-profile__shape -b" /><Shape name={c} className="loom-profile__shape -c" />
      </div>
      <div className="relative grid gap-4 px-6 pb-6">
        <div className="-mt-14 flex items-end gap-4">
          {agent ? <AgentAvatar a={agent} size={112} shape="circle" className="loom-profile__avatar" />
            : <span className={`loom-profile__avatar loom-profile__initials -${tone}`}>{p.initials ?? p.name[0]}</span>}
          {p.badges?.length ? <div className="mb-2 flex flex-wrap gap-2">{p.badges.map((x) => <Badge key={x} variant="olive">{x}</Badge>)}</div> : null}
        </div>
        <div className="grid min-w-0 gap-1.5">
          <h1 className="font-[family-name:var(--font-display)] text-3xl font-semibold leading-tight tracking-tight lg:text-4xl">{p.name}</h1>
          {p.summary && <p className="max-w-3xl leading-relaxed opacity-80">{p.summary}</p>}
        </div>
        {(p.stats?.length || p.links?.length) ? (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
            {p.stats?.map((s) => <span key={s.label} className="grid"><b className="font-[family-name:var(--font-display)] text-2xl font-semibold leading-none">{s.value}</b><Meta>{s.label}</Meta></span>)}
            {p.links?.length ? <div className="flex flex-wrap gap-2 sm:ml-auto">{p.links.map((l, n) => (
              <Button key={l.text} asChild variant={n === 0 ? 'accent' : 'secondary'} size="sm"><Link page={l.page} href={l.href} className="no-underline">{l.text}</Link></Button>
            ))}</div> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
