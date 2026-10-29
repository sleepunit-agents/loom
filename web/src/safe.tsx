// Nothing on a page may take the app down: an icon 000h doesn't have becomes a plain one, and a part
// that fails to draw says so (with a reload a tap away) instead of blanking everything.
import { Alert, AlertActions, AlertBody, AlertDescription, AlertIcon, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Component, type ReactNode } from 'react';
import { Icon, iconNames } from '@/components/ui/icon';

const KNOWN = new Set(iconNames);
const FALLBACK = ['circle', 'dot', 'square'].find((n) => KNOWN.has(n)) ?? iconNames[0];

/** A name 000h can draw: the one asked for, else a plain fallback. */
export const iconFor = (name: string | undefined) => (name && KNOWN.has(name) ? name : FALLBACK);

type Tone = 'info' | 'ok' | 'warn' | 'danger';
const TONE_ICON: Record<Tone, string> = { info: 'info', ok: 'circle-check', warn: 'triangle-alert', danger: 'circle-alert' };

/** 000h's Alert as it's meant to be put together: its icon blob first (the first of its two columns is the blob's;
 * without one the words land in that 40px column, a letter or two a line), then the words, then any buttons. */
export function Callout({ tone = 'info', icon, title, children, actions, className, role }: {
  tone?: Tone; icon?: string; title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string; role?: string;
}) {
  return (
    <Alert variant={tone} className={className} role={role}>
      <AlertIcon><Icon name={iconFor(icon ?? TONE_ICON[tone]) as never} /></AlertIcon>
      <AlertBody>{title && <AlertTitle>{title}</AlertTitle>}{children && <AlertDescription>{children}</AlertDescription>}
        {actions && <AlertActions>{actions}</AlertActions>}</AlertBody>
    </Alert>
  );
}

export class Boundary extends Component<{ children: ReactNode; where: string }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.message ?? e).slice(0, 200) }; }
  componentDidUpdate(prev: { where: string }) { if (prev.where !== this.props.where && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Callout tone="danger" title="This page couldn't be drawn in the app." actions={<Button size="sm" variant="outline" onClick={() => location.reload()}>Reload</Button>}>
        {this.state.error}
      </Callout>
    );
  }
}
