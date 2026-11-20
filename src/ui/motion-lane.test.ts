import { afterEach, expect, it, vi } from 'vitest';
import { createMotionLane } from '../../web/src/lib/cojeev-motion/choreography';
import { animateFlowLanding } from '../../web/src/lib/cojeev-motion/flow-motion';
import { motionClock } from '../../web/src/lib/cojeev-motion/clock';

afterEach(() => { motionClock(null); vi.unstubAllGlobals(); });

it('scalar motion seeks, retargets and cancels without completing the old owner', () => {
  motionClock(0);
  const paint = vi.fn(), old = vi.fn(), done = vi.fn();
  const lane = createMotionLane(0, paint);
  try {
    lane.to(10, { duration: 1, ease: 'linear' }, old);
    motionClock(400);
    expect(lane.get()).toBeCloseTo(4);
    lane.to(20, { duration: 1, ease: 'linear' }, done);
    motionClock(900);
    expect(lane.get()).toBeCloseTo(12);
    motionClock(1400);
    expect(lane.get()).toBe(20);
    expect(old).not.toHaveBeenCalled(); expect(done).toHaveBeenCalledTimes(1);
    lane.to(30, { duration: 1 }, old);
    lane.jump(7);
    motionClock(3000);
    expect(lane.get()).toBe(7); expect(old).not.toHaveBeenCalled();
  } finally { lane.dispose(); }
});

it('the landing aura paints on the same clock and cancellation restores the host', () => {
  const aura = { style: {} as Record<string, string>, remove: vi.fn() };
  vi.stubGlobal('document', { createElement: () => aura, getAnimations: () => [] });
  const styles = new Map([['transform', 'rotate(5deg)']]);
  const element = { append: vi.fn(), style: {
    getPropertyValue: (key: string) => styles.get(key) ?? '', getPropertyPriority: () => '',
    setProperty: (key: string, value: string) => styles.set(key, value), removeProperty: (key: string) => styles.delete(key),
  } };
  motionClock(0);
  const stop = animateFlowLanding(element as unknown as HTMLElement, 'ripple');
  expect(element.append).toHaveBeenCalledWith(aura);
  expect(aura.style.transform).toBe('scale(1)'); expect(aura.style.opacity).toBe('0.6');
  motionClock(100);
  expect(Number(aura.style.opacity)).toBeLessThan(.6);
  stop();
  expect(aura.remove).toHaveBeenCalled(); expect(styles.get('transform')).toBe('rotate(5deg)');
  motionClock(2000);
  expect(styles.get('transform')).toBe('rotate(5deg)');
});
