// @vitest-environment node
/**
 * Reduce motion and Higher contrast as <html> wears them (web/src/access.ts), with no browser: On and Off set the
 * attribute whatever the phone says; Follow sets the phone's answer and keeps up as it changes, until another choice
 * stops it; this device's kept copy reads back as a choice, Follow when there's none or it can't be read; and
 * motionQuery() answers the attribute and says when it changes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { keptFollow, motionQuery, reducedMotion, wearContrast, wearMotion } from '../../web/src/access';

/** A document whose phone answers `media`; `flip` changes one answer and tells whoever listens. */
function fakeDoc(media: Record<string, boolean>) {
  const listeners = new Map<string, Set<() => void>>();
  const doc = {
    documentElement: { dataset: {} as Record<string, string> },
    defaultView: {
      matchMedia: (q: string) => ({
        get matches() { return !!media[q]; },
        addEventListener: (_: string, f: () => void) => { (listeners.get(q) ?? listeners.set(q, new Set()).get(q)!).add(f); },
        removeEventListener: (_: string, f: () => void) => { listeners.get(q)?.delete(f); },
      }),
    },
  };
  const flip = (q: string, v: boolean) => { media[q] = v; for (const f of listeners.get(q) ?? []) f(); };
  return { doc: doc as unknown as Document, html: doc.documentElement.dataset, flip, listening: (q: string) => listeners.get(q)?.size ?? 0 };
}
const RM = '(prefers-reduced-motion: reduce)', HC = '(prefers-contrast: more)';
const g = globalThis as unknown as Record<string, unknown>;
afterEach(() => { delete g.localStorage; delete g.document; delete g.MutationObserver; });

describe('Reduce motion and Higher contrast on <html> (web/src/access.ts)', () => {
  it('On and Off win over the phone; Follow is the phone, kept up as it changes, until another choice', () => {
    const d = fakeDoc({ [RM]: true, [HC]: true });
    wearMotion('off', d.doc); wearContrast('off', d.doc);
    expect([d.html.motion, d.html.contrast]).toEqual(['full', 'normal']);
    expect(d.listening(RM) + d.listening(HC)).toBe(0);
    wearMotion('follow', d.doc); wearContrast('follow', d.doc);
    expect([d.html.motion, d.html.contrast]).toEqual(['reduce', 'more']);
    d.flip(RM, false); d.flip(HC, false);
    expect([d.html.motion, d.html.contrast]).toEqual(['full', 'normal']);
    // On: the phone's answer no longer matters, and nothing is listening to it.
    wearMotion('on', d.doc); wearContrast('on', d.doc);
    expect([d.html.motion, d.html.contrast]).toEqual(['reduce', 'more']);
    expect(d.listening(RM) + d.listening(HC)).toBe(0);
    d.flip(RM, false);
    expect(d.html.motion).toBe('reduce');
    // Follow twice listens once.
    wearMotion('follow', d.doc); wearMotion('follow', d.doc);
    expect(d.listening(RM)).toBe(1);
  });

  it('this device\'s copy: a choice, Follow when there is none, a stranger value, or no storage at all', () => {
    const kept: Record<string, string> = { 'loom-motion': 'on', 'loom-contrast': 'sideways' };
    g.localStorage = { getItem: (k: string) => kept[k] ?? null };
    expect([keptFollow('loom-motion'), keptFollow('loom-contrast')]).toEqual(['on', 'follow']);
    delete kept['loom-motion'];
    expect(keptFollow('loom-motion')).toBe('follow');
    g.localStorage = { getItem: () => { throw new Error('private window'); } };
    expect(keptFollow('loom-motion')).toBe('follow');
  });

  it('motionQuery() answers the attribute, and says when it changes (and only then)', () => {
    const html = { dataset: { motion: 'full' } as Record<string, string> };
    const observers: Array<() => void> = [];
    g.document = { documentElement: html };
    g.MutationObserver = class { constructor(f: () => void) { observers.push(f); } observe() {} };
    const q = motionQuery();
    expect([q.matches, reducedMotion()]).toEqual([false, false]);
    let told = 0;
    const f = () => { told++; };
    q.addEventListener('change', f);
    html.dataset.motion = 'reduce'; observers.forEach((o) => o());
    expect([q.matches, told]).toEqual([true, 1]);
    observers.forEach((o) => o());   // set again to the same: no change to tell
    expect(told).toBe(1);
    q.removeEventListener('change', f);
    html.dataset.motion = 'full'; observers.forEach((o) => o());
    expect(told).toBe(1);
  });
});
