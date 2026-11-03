// The app's own states (Jonathan, 2026-11-03: "restyle them to match the rest of loom, so nothing falls back to bare
// default shapes … say what happened in plain words and offer a retry"): a page that didn't load, a loom that can't be
// reached, a page with nothing on it yet, and a page on its way. Each one is a loom card with the app's tinted mark,
// one sentence and at most one thing to do. No status codes, no paths.
import type { ReactNode } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Button } from '@/components/ui/button';
import { iconFor } from './safe';
import { useTint } from './tint';

export function StateCard({ icon, tint, app, title, text, action, quiet }: {
  /** app: the app it's about, whose colour the mark wears (tint.ts), when no tint is given. */
  icon: string; tint?: string; app?: string; title: string; text?: ReactNode; action?: { label: string; onClick: () => void }; quiet?: boolean;
}) {
  const tintOf = useTint();
  return (
    <div role={quiet ? undefined : 'status'} className={`loom-state grid justify-items-center gap-3 rounded-[var(--r-card,24px)] px-6 text-center ${quiet ? 'py-8' : 'py-12'}`}>
      <span aria-hidden className="loom-state-mark loom-app-tile grid size-16 place-items-center rounded-[30%]" data-tint={tint ?? tintOf(app ?? title)}>
        <AnimatedIcon name={iconFor(icon)} />
      </span>
      <p className="font-[family-name:var(--font-display)] text-xl font-semibold leading-tight">{title}</p>
      {text && <p className="max-w-[36ch] text-sm opacity-70">{text}</p>}
      {action && <Button variant="outline" className="mt-1 gap-2" onClick={action.onClick}><AnimatedIcon name={iconFor('rotate-cw')} size="sm" />{action.label}</Button>}
    </div>
  );
}

/** A page on its way: its shape, breathing, where the last page used to sit dimmed under a spinner. */
export function Skeleton() {
  return (
    <div aria-hidden className="grid gap-4">
      {[0, 1, 2].map((n) => (
        <div key={n} className="loom-skel grid gap-3 rounded-[var(--r-card,24px)] p-6" style={{ animationDelay: `${n * 120}ms` }}>
          <span className="loom-skel-line h-4 w-1/3 rounded-full" />
          <span className="loom-skel-line h-3 w-5/6 rounded-full" />
          <span className="loom-skel-line h-3 w-2/3 rounded-full" />
        </div>
      ))}
    </div>
  );
}
