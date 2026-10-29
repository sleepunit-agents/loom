// Nothing on a page may take the app down: an icon 000h doesn't have becomes a plain one, and a part
// that fails to draw says so (with the classic page a tap away) instead of blanking everything.
import { Component, type ReactNode } from 'react';
import { iconNames } from '@/components/ui/icon';

const KNOWN = new Set(iconNames);
const FALLBACK = ['circle', 'dot', 'square'].find((n) => KNOWN.has(n)) ?? iconNames[0];

/** A name 000h can draw: the one asked for, else a plain fallback. */
export const iconFor = (name: string | undefined) => (name && KNOWN.has(name) ? name : FALLBACK);

export class Boundary extends Component<{ children: ReactNode; where: string }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.message ?? e).slice(0, 200) }; }
  componentDidUpdate(prev: { where: string }) { if (prev.where !== this.props.where && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-3xl border p-5">
        <p className="font-medium">This page couldn't be drawn in the app.</p>
        <p className="text-sm opacity-70">{this.state.error}</p>
        <a className="mt-3 inline-block underline underline-offset-4" href={`${location.pathname}${location.search ? `${location.search}&` : '?'}ui=classic`}>Open it the classic way</a>
      </div>
    );
  }
}
