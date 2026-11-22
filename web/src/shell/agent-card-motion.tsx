import { Component, type ReactNode, type RefObject } from 'react';
import { motionQuery, reducedMotion } from '../access';

type Props = { ground: RefObject<HTMLDivElement | null>; home: boolean; phone: boolean; children: ReactNode };
type Position = { frame: DOMRect; face?: DOMRect };
type Positions = Map<string, Position>;
const timing = { duration:760, easing:'cubic-bezier(.2,.74,.2,1)' };

function portrait(card: HTMLElement) {
  return card.querySelector<HTMLElement>('.desk-solo-face') ?? card.querySelector<HTMLElement>('.desk-agent-face');
}

// Keep the portrait square while the card changes aspect ratio. Both travel
// between their own measured positions on the same clock.
function portraitFrames(start: Position, end: Position) {
  const a = start.face!, b = end.face!;
  const fromX = a.left-start.frame.left, fromY = a.top-start.frame.top;
  const toX = b.left-end.frame.left, toY = b.top-end.frame.top;
  return Array.from({length:17}, (_,i) => {
    const t = i/16, mix = (from:number,to:number) => from*(1-t)+to*t;
    const sx = mix(start.frame.width/end.frame.width,1), sy = mix(start.frame.height/end.frame.height,1);
    const x = mix(fromX,toX)/sx-toX, y = mix(fromY,toY)/sy-toY;
    return {transformOrigin:'top left',transform:`translate(${x}px,${y}px) scale(${mix(a.width/b.width,1)/sx},${mix(a.height/b.height,1)/sy})`};
  });
}

function cards(ground: HTMLElement, home: boolean) {
  const selector = home ? ':scope > .desk-home [data-agent]' : ':scope > .next-rail:not([inert]) .desk-agent-rail [data-agent]';
  return [...ground.querySelectorAll<HTMLElement>(selector)].filter(card => card.offsetWidth && card.offsetHeight);
}

/** Read the departing card before React removes Home or the rail. The destination
 * may mount a commit later while its live roster subscription is opening. */
export class AgentCardMotion extends Component<Props, object, Positions | null> {
  private stop?: () => void;

  getSnapshotBeforeUpdate(previous: Props) {
    const ground = this.props.ground.current;
    if (!ground || previous.home === this.props.home || previous.phone || this.props.phone || reducedMotion()) return null;
    return new Map(cards(ground, previous.home).map(card => [card.dataset.agent!, {frame:card.getBoundingClientRect(),face:portrait(card)?.getBoundingClientRect()}]));
  }

  componentDidUpdate(previous: Props, _state: object, from: Positions | null) {
    if (previous.home === this.props.home && previous.phone === this.props.phone) return;
    this.stop?.();
    const ground = this.props.ground.current;
    if (!ground || !from?.size || this.props.phone || reducedMotion()) return;
    const animations: Animation[] = [];
    const home = this.props.home;
    const match = () => {
      for (const card of cards(ground, home)) {
        const id = card.dataset.agent!, start = from.get(id);
        if (!start) continue;
        const end = card.getBoundingClientRect();
        if (!end.width || !end.height) continue;
        from.delete(id);
        const x = start.frame.left - end.left, y = start.frame.top - end.top;
        const face = portrait(card), faceEnd = face?.getBoundingClientRect();
        if (face && start.face?.width && start.face.height && faceEnd?.width && faceEnd.height)
          animations.push(face.animate(portraitFrames(start,{frame:end,face:faceEnd}), timing));
        card.dataset.cardFlight = home ? 'expand' : 'collapse';
        const animation = card.animate([
          { transformOrigin:'top left', transform:`translate(${x}px,${y}px) scale(${start.frame.width/end.width},${start.frame.height/end.height})` },
          { transformOrigin:'top left', transform:'none' },
        ], { ...timing, id:'loom-agent-card' });
        animations.push(animation);
        const settled = () => { delete card.dataset.cardFlight; };
        void animation.finished.then(settled, settled);
      }
      if (!from.size) observer.disconnect();
    };
    const observer = new MutationObserver(match);
    observer.observe(ground,{childList:true,subtree:true});
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
        if (this.stop === stop) stop();
      });
    }, 400);
    const motion = motionQuery();
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      for (const animation of animations) animation.cancel();
      motion.removeEventListener('change', stop);
      this.stop = undefined;
    };
    motion.addEventListener('change', stop);
    this.stop = stop;
    match();
  }

  componentWillUnmount() { this.stop?.(); }
  render() { return this.props.children; }
}
