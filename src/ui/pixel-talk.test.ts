// @vitest-environment node
/**
 * Talking on the comm screen (docs/specs/comms.md, "How talking plays"; criterion 17): a bounded run of talking beats,
 * a 400-1200 ms breath between them, then the done beat, then rest as idle; a reply mid-run extends it, never past 4;
 * nothing while it isn't live (reduced motion, off screen); a manifest without talking plays done's, then working's.
 * And the channel line's harness word (loom-box t-1907).
 */
import { describe, expect, it } from 'vitest';
import { createPlayer, PIXEL, stateFrom, type Frame, type PlayerEnv } from '../../web/src/pixel-face';
import { faceOf, talkBeats, newId, onOf, replyHtml, staysInside, MARKED_REF } from '../../web/src/comms';
import { batches, BATCH, cardHref, cardPage } from '../../web/src/comms-refs';
import { verdictOfAction } from '../../web/src/comms-asks';
import { CARD_PAGE, REFS_MAX, refShape } from '../comms-refs.js';
import { verdictOf } from '../comms-asks.js';

function fakeEnv(seed = 11): PlayerEnv & { run: (ms: number) => void; t: () => number } {
  let now = 0, id = 0, s = seed;
  const timers = new Map<number, { at: number; f: () => void }>();
  return {
    now: () => now, t: () => now,
    setTimeout: (f, ms) => { timers.set(++id, { at: now + ms, f }); return id; },
    clearTimeout: (t) => { timers.delete(t); },
    random: () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; },
    run(ms) {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; f: () => void }] | undefined;
        for (const e of timers) if (!next || e[1].at < next[1].at) next = e;
        if (!next || next[1].at > end) break;
        timers.delete(next[0]); now = next[1].at; next[1].f();
      }
      now = end;
    },
  };
}
const v = (row: number, frames = 17, weight = 1, rare = false) => ({ row, frames, weight, ...(rare ? { rare } : {}) });
const BASE = {
  idle: { south: [v(10)] }, working: { south: [v(4)] }, thinking: { south: [v(13)] }, error: { south: [v(1)] },
  done: { south: [v(19, 9)] }, waiting: { south: [v(25)] },
};
// Art's src4 layout: talking 70, animated 20, smug aside 10 (rare).
const ART = { cell: [56, 84] as [number, number], states: { ...BASE, talking: { south: [v(7, 17, 70), v(16, 17, 20), v(22, 17, 10, true)] } } };
type Draw = Frame & { at: number };
function play(m: typeof ART | { cell: [number, number]; states: Record<string, unknown> }, seed?: number) {
  const env = fakeEnv(seed);
  const draws: Draw[] = [];
  const p = createPlayer(m as never, 'idle', (f) => draws.push({ ...f, at: env.t() }), env);
  return { env, draws, p };
}
/** Beats as [from, start time, end time]. */
function beats(draws: Draw[]) {
  const out: Array<{ from: string; start: number; end: number; row: number }> = [];
  for (const d of draws) {
    if (!d.beat) continue;
    if (d.frame === 0) out.push({ from: d.from, start: d.at, end: d.at, row: d.v?.row ?? -1 });
    else out[out.length - 1].end = d.at;
  }
  return out;
}

describe('talking', () => {
  it('a run of n talking beats, each breath 400-1200 ms, then the done beat, then idle', () => {
    const { env, draws, p } = play(ART);
    p.live(true);
    p.talk(3);
    env.run(20_000);
    const b = beats(draws);
    const talk = b.filter((x) => x.from === 'talking');
    expect(talk).toHaveLength(3);
    for (let i = 1; i < talk.length; i++) {
      const gap = talk[i].start - talk[i - 1].end - PIXEL.frameMs;
      expect(gap).toBeGreaterThanOrEqual(400);
      expect(gap).toBeLessThanOrEqual(1200);
    }
    const after = b[b.indexOf(talk[2]) + 1];
    expect(after.from).toBe('done');
    expect(draws.at(-1)!.from).toBe('idle');
  });

  it('a reply mid-run extends it, never past 4 beats in all', () => {
    const { env, draws, p } = play(ART);
    p.live(true);
    p.talk(3);
    env.run(2000);
    p.talk(3);
    env.run(30_000);
    expect(beats(draws).filter((x) => x.from === 'talking')).toHaveLength(4);
  });

  it('a rare variant (the smug aside) never plays twice running', () => {
    for (let seed = 1; seed < 40; seed++) {
      const { env, draws, p } = play(ART, seed);
      p.live(true);
      p.talk(4);
      env.run(30_000);
      const rows = beats(draws).filter((x) => x.from === 'talking').map((x) => x.row);
      for (let i = 1; i < rows.length; i++) expect(rows[i] === 22 && rows[i - 1] === 22).toBe(false);
    }
  });

  it('still (reduced motion, off screen): no talking beat at all', () => {
    const { env, draws, p } = play(ART);
    p.talk(3);
    env.run(20_000);
    expect(beats(draws).filter((x) => x.from === 'talking')).toHaveLength(0);
  });

  it('a manifest without talking plays done\'s, then working\'s', () => {
    expect(stateFrom({ cell: [1, 1], states: BASE } as never, 'talking')).toBe('done');
    const { done: _d, ...noDone } = BASE;
    expect(stateFrom({ cell: [1, 1], states: noDone } as never, 'talking')).toBe('working');
    expect(stateFrom(ART as never, 'talking')).toBe('talking');
    const { env, draws, p } = play({ cell: [56, 84], states: BASE });
    p.live(true);
    p.talk(1);
    env.run(10_000);
    expect(beats(draws)[0].from).toBe('done');
  });
});

describe('the comm screen\'s rules', () => {
  it('beats per reply: one per 150 characters, 1 to 4', () => {
    expect(talkBeats(0)).toBe(1);
    expect(talkBeats(400)).toBe(3);
    expect(talkBeats(2000)).toBe(4);
  });
  it('the face by precedence: error, then an ask, then talking, then working, then thinking', () => {
    const s = { failed: false, asking: false, talking: false, working: false, waitingOnAgent: false };
    expect(faceOf({ ...s, failed: true, asking: true, talking: true })).toBe('error');
    expect(faceOf({ ...s, asking: true, working: true, talking: true })).toBe('needs-input');
    expect(faceOf({ ...s, talking: true, working: true })).toBe('talking');
    expect(faceOf({ ...s, working: true, waitingOnAgent: true })).toBe('working');
    expect(faceOf({ ...s, waitingOnAgent: true })).toBe('thinking');
    expect(faceOf(s)).toBe('idle');
  });
  it('message ids are 16 base32 characters', () => {
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(/^[a-z2-7]{16}$/);
  });
  it('a bare repo#N is marked under the household\'s GitHub owner, and is words without one', () => {
    expect(replyHtml('Merged app#7.', 'acme')).toContain('<span class="comms-ref" data-ref="github:acme/app#7">acme/app#7</span>');
    expect(replyHtml('Merged app#7.')).not.toContain('data-ref');
  });
  it('a reply\'s tasks, PRs, conversations and notes are marked, never links until the thread knows them (t-1979); http and javascript stay words', () => {
    const h = replyHtml('See t-12, acme/app#3 and cv-0123456789ab, note:pond/plan, [x](http://evil.example) and [y](javascript:alert(1)).');
    expect(h).toContain('<span class="comms-ref" data-ref="t-12">t-12</span>');
    expect(h).toContain('<span class="comms-ref" data-ref="github:acme/app#3">acme/app#3</span>');
    expect(h).toContain('<span class="comms-ref" data-ref="cv-0123456789ab">cv-0123456789ab</span>');
    expect(h).toContain('<span class="comms-ref" data-ref="note:pond/plan"><code>note:pond/plan</code></span>');
    expect(h).not.toContain('<a ');
    expect(h).not.toMatch(/href="http:/);
    expect(h).not.toMatch(/href="javascript/i);
    // Whatever case the scheme is in.
    for (const x of ['[x](HTTP://evil.example)', '[x](Http://evil.example)', 'HTTP://evil.example']) expect(replyHtml(x), x).not.toMatch(/href="http:/i);
  });
  it('a ref in code, in a link the agent wrote or in a URL is left as written', () => {
    const h = replyHtml('Run `git log @mark t-12` then\n\n```\nnpm i @scope/pkg # t-9\n```\n\nSee [the t-12 notes](https://example.com/t-12) and https://github.com/acme/app/issues/3 for a-0123abcd.');
    expect(h).toContain('<code>git log @mark t-12</code>');
    expect(h).toContain('npm i @scope/pkg # t-9');
    expect(h).toContain('href="https://example.com/t-12"');
    expect(h).toContain('>the t-12 notes</a>');
    expect(h).not.toContain('loom.invalid');
    // Outside them, still marked.
    expect(h).toContain('data-ref="a-0123abcd"');
    expect(h.match(/data-ref=/g)).toHaveLength(1);
    for (const x of ['~~~\nsee t-12\n~~~', 'Code:\n\n    npm i @scope/pkg t-12\n']) {
      const c = replyHtml(x);
      expect(c, x).not.toContain('data-ref');
      expect(c, x).not.toContain('loom.invalid');
    }
    // A link the agent spells as loom's own mark is never taken for one: its words, no chip.
    for (const x of ['[t-5 · closed](https://loom.invalid/ref/t-12)', '[x](https://loom.invalid/ref-0011223344556677/t-12)']) expect(replyHtml(x), x).not.toContain('data-ref');
  });
  it('a reply\'s other loom things are marked, not linked: an approval, a knowledge page, a project, a person, an @agent', () => {
    const h = replyHtml('Filed a-0123abcd; see [[dns-health]], project:pond, person:loren and @mark. Not a-xyz or me@mark.dev.');
    for (const r of ['a-0123abcd', 'knowledge:dns-health', 'project:pond', 'person:loren', 'at:mark']) expect(h, r).toContain(`<span class="comms-ref" data-ref="${r}">`);
    expect(h).toContain('>dns-health</span>');
    expect(h).not.toContain('loom.invalid');
    expect(h).not.toContain('data-ref="a-xyz');
    // An address isn't an @: me@mark.dev marks nothing (the one @mark above is the only at: ref).
    expect(h.match(/data-ref="at:/g)).toHaveLength(1);
    expect(replyHtml('Write to me@mark.dev.')).not.toContain('data-ref');
    // A marked ref an agent spells out as a URL with anything else in it is its words.
    expect(replyHtml('[x](https://loom.invalid/ref/%22%3E%3Cimg)')).not.toContain('data-ref');
  });
  it('an inside-looking link an agent writes is a link only to an allowed page, and never leaves loom', () => {
    const evil = ['//evil.com', '/\\evil', '../x', 'p/tasks/../../x', 'javascript:alert(1)', 'p/notes/x', 'conversation/cv-zz', 'p/tasks/t-12?next=//evil.com'];
    for (const path of evil) {
      const h = replyHtml(`[go](https://loom.invalid/${path})`);
      expect(h, path).not.toContain('data-inside');
      expect(h, path).not.toMatch(/href="\/(?!\/p\/tasks\/task\/t-\d+")/);
    }
    // A link into loom an agent writes, even to an allowed page, is its words: inside loom opens only as a chip.
    for (const x of ['[Open](https://loom.invalid/p/tasks/task/t-12)', '[c](https://loom.invalid/conversation/cv-0123456789ab)']) expect(replyHtml(x), x).not.toContain('<a ');
    expect(replyHtml('[t](https://loom.invalid/p/tasks/t-12)')).not.toContain('href="https://loom.invalid');
    const here = 'https://loom.example/comms/th:aaaaaaaaaa';
    expect(staysInside('/p/tasks/task/t-12', here)).toBe(true);
    expect(staysInside('/p/tasks/t-12', here)).toBe(false);
    expect(staysInside('/conversation/cv-0123456789ab', here)).toBe(true);
    for (const href of ['//evil.com/p/tasks/t-1', '/\\evil.com', 'https://evil.com/p/tasks/t-1', 'javascript:alert(1)', '/../x', '/p/tasks/t-1/../../admin', '/p/notes/x']) {
      expect(staysInside(href, here), href).toBe(false);
    }
  });
});

describe('a chip\'s card opens only where it may (t-1979)', () => {
  it('Open goes to an allowed inside page or an https link, and the client and the server agree on the pages', () => {
    const c = (page?: string, href?: string) => ({ kind: 'task' as const, title: 'x', ...(page !== undefined ? { page } : {}), ...(href !== undefined ? { href } : {}) });
    for (const p of ['p/tasks/task/t-12', 'conversation/cv-0123456789ab', 'knowledge/dns-health', 'projects/pond', 'people/loren', 'a/mark', 'inbox']) {
      expect(cardPage(c(p)), p).toBe(`/${p}`);
      expect(CARD_PAGE.test(p), p).toBe(true);
    }
    for (const p of ['\\evil.com', '/evil', '//evil.com', 'p/tasks/task/t-12?x=1', 'p/tasks/../admin', 'javascript:alert(1)', 'a/Mark', 'knowledge/../x', 'inbox/x']) {
      expect(cardPage(c(p)), p).toBeUndefined();
      expect(CARD_PAGE.test(p), p).toBe(false);
    }
    expect(cardHref(c(undefined, 'https://github.com/acme/app/issues/3'))).toBe('https://github.com/acme/app/issues/3');
    for (const h of ['javascript:alert(1)', 'http://github.com/x', 'https://x" onmouseover="y', 'https://a\\b', ' https://x']) expect(cardHref(c(undefined, h)), h).toBeUndefined();
  });
  it('the client and the server agree on what a ref is, and on the answer a button gives', () => {
    const samples = ['t-1', 't-1234567890', 'github:acme/app#3', 'github:a/b#c', 'cv-0123456789ab', 'cv-1', 'a-0123abcd', 'a-0123', 'note:a/b', 'note:a/../b', 'note:',
      'knowledge:x', 'project:x', 'person:x', 'agent:x', 'at:x', 'at:X', 'evil:x', 't-1" onclick="x', 'note:.hidden'];
    for (const r of samples) expect(MARKED_REF.test(r) && !r.split('/').includes('..'), r).toBe(!!refShape(r));
    for (const [a, f] of [['allow', {}], ['deny', {}], ['needs-answer', { answer: 'yes' }], ['needs-answer', { answer: 'no' }], ['needs-answer', { answer: 'maybe' }],
      ['needs-reply', {}], ['needs-done', {}], ['needs-dismiss', {}], ['snooze', {}]] as Array<[string, Record<string, string>]>) expect(verdictOfAction(a, f), a).toBe(verdictOf(a, f));
  });
  it('the thread asks in reads of at most the server\'s 60, each ref once', () => {
    const refs = Array.from({ length: 130 }, (_, i) => `t-${i % 125}`);
    const b = batches(refs);
    expect(b.map((x) => x.length)).toEqual([60, 60, 5]);
    expect(BATCH).toBe(REFS_MAX);
  });
  it('a reply marks only refs of a known shape', () => {
    for (const r of ['t-1', 'github:acme/app#3', 'cv-0123456789ab', 'a-0123abcd', 'note:a/b', 'knowledge:x', 'project:x', 'person:x', 'agent:x', 'at:x']) expect(MARKED_REF.test(r), r).toBe(true);
    for (const r of ['t-x', 'a-0123', 'cv-1', 'note:', 'at:X', 'evil:x', 'github:a/b#c', 't-1" onclick="x']) expect(MARKED_REF.test(r), r).toBe(false);
  });
});

describe('the channel line names a switched harness (loom-box t-1907)', () => {
  const reply = (seq: number, card: Record<string, unknown> | null) => ({ seq, at: '', kind: 'reply' as const, from: 'art', id: `r${seq}`, text: 'x', card, run: null, delivered: null });
  it('is the latest reply\'s `on`, and nothing once a reply comes from the agent\'s own harness again', () => {
    expect(onOf([reply(1, null)])).toBeNull();
    expect(onOf([reply(1, null), reply(2, { on: 'Codex' })])).toBe('Codex');
    expect(onOf([reply(1, { on: 'Codex' }), reply(2, null)])).toBeNull();
    // What follows a switched reply that isn't a reply (a card, an error, the member's message) doesn't clear it.
    const other = (seq: number, kind: 'card' | 'error' | 'message') => ({ ...reply(seq, kind === 'card' ? { tool: 'Bash', state: 'done' } : null), kind });
    expect(onOf([reply(1, { on: 'Codex' }), other(2, 'card'), other(3, 'error'), other(4, 'message')])).toBe('Codex');
  });
});
