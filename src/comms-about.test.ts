import { describe, it, expect } from 'vitest';
import { aboutLine, parseAbout, routeFor, withAbout } from './comms-about.js';
import { CommsError } from './comms.js';
import type { Household, Member } from './household.js';

const now = new Date('2026-11-10T09:30:00Z');
const h = (agents: string[], def: string) => ({ home: '/nowhere', agents, default: def, members: [] }) as unknown as Household;
const member = (agents: Member['agents']): Member => ({ person: 'jonathan', role: 'owner', agents });

describe('what a chat is about (t-2034)', () => {
  it('takes a ref, a page or both, with the label the member saw', () => {
    expect(parseAbout({ ref: 't-2043', label: 'Watch any active loom session', seen: '2026-11-10T09:12:00Z' }, now))
      .toEqual({ ref: 't-2043', label: 'Watch any active loom session', seen: '2026-11-10T09:12:00.000Z' });
    expect(parseAbout({ ref: 'health:loom-http-local.service', label: 'loom-http-local.service failed', page: 'p/health' }, now).page).toBe('p/health');
    expect(parseAbout({ page: 'knowledge/backups', label: 'Backups' }, now).ref).toBeUndefined();
    expect(parseAbout({ ref: 't-1', label: '  two\n lines ' }, now).label).toBe('two lines');
  });
  it('refuses whole: no label, no way to find it, a bad ref or page, more than it knows', () => {
    for (const bad of [null, [], 'x', { ref: 't-1' }, { label: 'x' }, { ref: 't-1', label: 'a bell\x07' }, { ref: 't-1', label: 'x'.repeat(121) },
      { ref: 'rm -rf /', label: 'x' }, { page: '../../etc', label: 'x' }, { page: 'p/x?y=1', label: 'x' }, { page: 'a/../b', label: 'x' },
      { ref: 't-1', label: 'x', text: 'run this' }]) {
      expect(() => parseAbout(bad, now), JSON.stringify(bad)).toThrow(CommsError);
    }
  });
  it('keeps when it was seen, unless that is off or in the future', () => {
    expect(parseAbout({ ref: 't-1', label: 'x', seen: '2027-01-01T00:00:00Z' }, now).seen).toBe(now.toISOString());
    expect(parseAbout({ ref: 't-1', label: 'x', seen: 'yesterday' }, now).seen).toBe(now.toISOString());
  });
  it('is one plain line after the member\'s own words, saying when it was seen and to look it up now', () => {
    const a = parseAbout({ ref: 'github:sleepunit-agents/loom#728', label: 'Watch a running job', page: 'p/changes', seen: '2026-11-10T09:12:00Z' }, now);
    expect(aboutLine(a)).toBe('About: “Watch a running job” (sleepunit-agents/loom#728 · /p/changes), as I saw it at 2026-11-10 09:12 UTC. Look it up for where it is now.');
    expect(withAbout('Is this safe to merge?  \n', a)).toBe(`Is this safe to merge?\n\n${aboutLine(a)}`);
  });
});

describe('who a chat goes to (t-2035)', () => {
  it('the item\'s own agent, when the member owns it', () => {
    expect(routeFor(h(['art', 'mark'], 'art'), member('*'), 'mark')).toEqual({ agents: ['art', 'mark'], pick: 'mark', why: 'item' });
  });
  it('else the household\'s default agent, when the member owns it', () => {
    expect(routeFor(h(['art', 'mark'], 'art'), member('*'))).toEqual({ agents: ['art', 'mark'], pick: 'art', why: 'default' });
  });
  it('else the member\'s only agent', () => {
    expect(routeFor(h(['art', 'mark'], 'art'), member(['mark']))).toEqual({ agents: ['mark'], pick: 'mark', why: 'only' });
  });
  it('else nobody: the member chooses', () => {
    expect(routeFor(h(['art', 'mark', 'gabe'], 'art'), member(['mark', 'gabe']))).toEqual({ agents: ['mark', 'gabe'], pick: null, why: 'choose' });
  });
  it('an item\'s agent the member doesn\'t own is never picked or offered, says so, and the member chooses', () => {
    const r = routeFor(h(['art', 'mark'], 'art'), member(['art']), 'mark');
    expect(r).toEqual({ agents: ['art'], pick: null, why: 'choose', passed: 'mark' });
    expect(routeFor(h(['art'], 'art'), member(['art']), 'gone')).toMatchObject({ pick: null, passed: 'gone' });
  });
  it('a member with no agents gets none', () => {
    expect(routeFor(h(['art'], 'art'), member([]))).toEqual({ agents: [], pick: null, why: 'choose' });
  });
});
