/**
 * Work in a Comms thread, the pure parts (docs/specs/comms.md, "Work in this thread", criteria 20 and 21): the refs a
 * text names, a thread feed's answer, the merge and its order, and the `sections.thread` offer's schema.
 */
import { describe, it, expect } from 'vitest';
import { mergeWork, noteItems, parseThreadFeed, refsIn, sortWork, type WorkItem } from './comms-work.js';
import { parseOffers } from './offers.js';

describe('refsIn: the grammar (criterion 20)', () => {
  it('keeps tasks, changes and notes, each once, in the order named', () => {
    expect(refsIn('see t-12, acme/app#3 and note:pond/plan; t-12 again')).toEqual(['t-12', 'github:acme/app#3', 'note:pond/plan']);
    expect(refsIn('made t-40')).toEqual(['t-40']);
  });

  it('a bare repo#N only under household.json\'s github', () => {
    expect(refsIn('fixed in app#3')).toEqual([]);
    expect(refsIn('fixed in app#3', 'acme')).toEqual(['github:acme/app#3']);
  });

  it('not cv- ids, URLs as such, at-12, x/acme/app#3 or notes:x; a note keeps its path without the stop', () => {
    expect(refsIn('cv-0123456789ab https://example.com/page at-12 x/acme/app#3 notes:x')).toEqual([]);
    expect(refsIn('read note:pond/plan.')).toEqual(['note:pond/plan']);
    expect(refsIn('note:../etc/passwd')).toEqual([]);
    expect(refsIn('(t-12)')).toEqual(['t-12']);
  });
});

describe('parseThreadFeed: a piece\'s answer (criterion 21)', () => {
  const ok = { title: 'Fix the frame', ref: 't-1', status: 'Blocked', tone: 'bad', when: '2026-11-05T21:10:00Z', page: 'task/t-1', made: true };

  it('takes a well-formed answer', () => {
    expect(parseThreadFeed({ items: [ok] })).toEqual({ items: [ok] });
  });

  it('reads made: false as absent', () => {
    expect(parseThreadFeed({ items: [{ ...ok, made: false }] })).toEqual({ items: [{ ...ok, made: undefined }].map(({ made: _m, ...r }) => r) });
  });

  it('refuses the whole answer for any one broken field', () => {
    for (const bad of [
      { items: [{ ...ok, extra: 1 }] },
      { items: Array.from({ length: 51 }, () => ok) },
      { items: [{ ...ok, status: 'x'.repeat(25) }] },
      { items: [{ ...ok, tone: 'red' }] },
      { items: [{ ...ok, when: 'yesterday' }] },
      { items: [{ ...ok, href: 'https://x.test' }] },
      { items: [{ ...ok, page: undefined, href: 'http://x.test' }] },
      { items: [{ ...ok, made: 'yes' }] },
      { items: [ok], more: 1 },
    ]) expect(typeof parseThreadFeed(bad)).toBe('string');
  });
});

describe('the merge and its order (criterion 21)', () => {
  const it_ = (ref: string, o: Partial<WorkItem> = {}): WorkItem => ({ title: ref, ref, status: 'Open', from: 'tasks', ...o });

  it('bad, then warn, then the rest; newest first within each; undated last', () => {
    const got = sortWork([
      it_('a', { when: '2026-11-05T10:00:00Z' }), it_('b', { tone: 'warn', when: '2026-11-04T10:00:00Z' }),
      it_('c', { tone: 'bad', when: '2026-11-01T10:00:00Z' }), it_('d'), it_('e', { when: '2026-11-05T12:00:00Z', tone: 'ok' }),
    ]).map((x) => x.ref);
    expect(got).toEqual(['c', 'b', 'e', 'a', 'd']);
  });

  it('one per ref: the first answer marked made survives whole, else the first answer', () => {
    const merged = mergeWork([
      [it_('t-1', { status: 'Open', from: 'changes' })],
      [it_('t-1', { status: 'Blocked', tone: 'bad', made: true, from: 'tasks' })],
      [it_('t-2', { status: 'Open', from: 'changes' }), it_('t-2', { status: 'Done', from: 'tasks' })],
    ]);
    expect(merged.find((x) => x.ref === 't-1')).toEqual(it_('t-1', { status: 'Blocked', tone: 'bad', made: true, from: 'tasks' }));
    expect(merged.find((x) => x.ref === 't-2')!.status).toBe('Open');
  });

  it("core lists notes by their path, with no link", () => {
    expect(noteItems([{ ref: 'note:pond/plan', at: '2026-11-05T10:00:00Z' }, { ref: 't-1', at: '2026-11-05T10:00:00Z' }]))
      .toEqual([{ title: 'pond/plan', ref: 'note:pond/plan', status: 'Note', when: '2026-11-05T10:00:00Z', from: 'loom' }]);
  });
});

describe('the sections.thread offer (criterion 21)', () => {
  const bins = ['loom-tasks'];
  const thread = { label: 'Tasks', argv: ['loom-tasks', 'thread-feed', '--json'] };

  it('is accepted alone or beside project', () => {
    expect(parseOffers({ sections: { thread } }, { bins })).toEqual({ sections: { thread } });
    const both = parseOffers({ sections: { project: { label: 'Tasks', argv: ['loom-tasks', 'project-feed'] }, thread } }, { bins });
    expect(typeof both === 'object' && both.sections?.thread).toEqual(thread);
  });

  it('is refused without a label, with an unknown key, or with another piece\'s bin', () => {
    expect(parseOffers({ sections: { thread: { argv: thread.argv } } }, { bins })).toMatch(/thread.label is required/);
    expect(parseOffers({ sections: { thread: { ...thread, unfiled: true } } }, { bins })).toMatch(/has no key "unfiled"/);
    expect(parseOffers({ sections: { thread: { ...thread, argv: ['sh', '-c', 'x'] } } }, { bins })).toMatch(/argv\[0\] must be one of the piece's own bins/);
    expect(parseOffers({ sections: { other: thread } }, { bins })).toMatch(/two keys, project and thread/);
  });
});
