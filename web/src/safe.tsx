// Nothing on a page may take the app down: an icon 000h doesn't have becomes a plain one, and a part
// that fails to draw says so (with a reload a tap away) instead of blanking everything.
import { Alert, AlertActions, AlertBody, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
      <Alert variant="danger">
        <AlertBody><AlertTitle>This page couldn't be drawn in the app.</AlertTitle><AlertDescription>{this.state.error}</AlertDescription></AlertBody>
        <AlertActions><Button size="sm" variant="outline" onClick={() => location.reload()}>Reload</Button></AlertActions>
      </Alert>
    );
  }
}
