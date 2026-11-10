// The Watching view's rows and its working line (t-2109): steps nest under the helper step that started them, a run's
// duration comes from its own times, ANSI colour codes become text runs and nothing else, and the line says working,
// quiet or stuck by itself.
import { describe, it, expect } from 'vitest';
import { aliveOf, ansiRuns, spanOf, stepsUnder, took, tokensWord, workTree, QUIET_MS, STUCK_MS, type WorkCard } from '../../web/src/steps';

const T0 = Date.parse('2026-11-10T10:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
let seq = 0;
const card = (id: string, tool: string, state: string, more: Record<string, unknown> = {}, text = id): WorkCard =>
  ({ id, seq: ++seq, at: iso(0), text, card: { tool, state, ...more } });

describe('work rows', () => {
  it('nests a helper\'s steps under the step that started it, and leaves the plan out', () => {
    const cards = [card('a', 'Agent', 'done'), card('b', 'Bash', 'done', { parent: 'a' }), card('w', 'text', 'done', { parent: 'a' }), card('c', 'Read', 'done', { parent: 'b' }),
      card('p', 'TodoWrite', 'done'), card('d', 'Bash', 'running'), card('e', 'Bash', 'done', { parent: 'nobody' })];
    const tree = workTree(cards);
    expect(tree.map((n) => n.c.id)).toEqual(['a', 'd', 'e']);
    expect(tree[0].kids.map((n) => n.c.id)).toEqual(['b', 'w']);
    expect(stepsUnder(tree[0])).toBe(2);
  });

  it('times a step from its own start and end, and a running one to now', () => {
    expect(spanOf(card('x', 'Bash', 'done', { t0: iso(0), t1: iso(133_000) }))).toEqual({ start: T0, end: T0 + 133_000 });
    expect(spanOf(card('y', 'Bash', 'running', { t0: iso(0) })).end).toBeNull();
    expect([took(4000), took(133_000), took(3_900_000)]).toEqual(['4s', '2m 13s', '1h 5m']);
    expect([tokensWord(812), tokensWord(4100), tokensWord(41_000), tokensWord(1_200_000)]).toEqual(['812', '4.1k', '41k', '1.2M']);
  });

  it('turns colour codes into runs of text; any other escape is nothing', () => {
    expect(ansiRuns('\x1b[1;31mFAIL\x1b[0m ok \x1b[32mpass')).toEqual([{ text: 'FAIL', fg: 'red', bold: true }, { text: ' ok ' }, { text: 'pass', fg: 'green' }]);
    expect(ansiRuns('<b>x</b>\x1b')).toEqual([{ text: '<b>x</b>' }]);
  });
});

describe('the working line', () => {
  const running = card('r', 'Bash', 'running', { t0: iso(0), limit: 120 }, 'Ran the tests');
  it('working while its body moved in the last two minutes, with its tokens', () => {
    const a = aliveOf({ alive_at: iso(60_000), tokens: 4100 }, [running], T0 + 90_000);
    expect(a).toMatchObject({ face: 'working', tokens: 4100, over: false });
    expect(a.step?.id).toBe('r');
  });
  it('quiet after two minutes with nothing, stuck after twelve', () => {
    const quiet = card('q', 'Bash', 'done', { t0: iso(0), t1: iso(1000) });
    expect(aliveOf({ alive_at: iso(1000) }, [quiet], T0 + 1000 + QUIET_MS).face).toBe('quiet');
    expect(aliveOf({ alive_at: iso(1000) }, [quiet], T0 + 1000 + STUCK_MS).face).toBe('stuck');
  });
  it('a body that says nothing at all is quiet, then stuck, counted from when it started working', () => {
    expect(aliveOf({ working_since: iso(0) }, [], T0 + 30_000).face).toBe('working');
    expect(aliveOf({ working_since: iso(0) }, [], T0 + QUIET_MS + 1000).face).toBe('quiet');
    expect(aliveOf({ working_since: iso(0) }, [], T0 + STUCK_MS + 1000).face).toBe('stuck');
  });
  it('stuck when a step runs past its own limit, even while the body still writes', () => {
    const a = aliveOf({ alive_at: iso(170_000) }, [running], T0 + 180_000);
    expect(a).toMatchObject({ face: 'stuck', over: true });
  });
});
