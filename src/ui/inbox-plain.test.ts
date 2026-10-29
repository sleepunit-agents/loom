import { describe, expect, it } from 'vitest';
import { plain } from '../../web/src/plain';

// The texts as the approvals and secrets pieces write them (live Inbox, 2026-10-29).
describe('the Inbox in plain words', () => {
  it('a secret request says which token, and the agent\'s why under it', () => {
    expect(plain({ text: 'art asked for github-jbarket-onterris-token: “check CI on onterris/terraform-on-pond#45 (t-1586 wx seed)”',
      outcome: 'Allowed for 480 min (by the policy); it ran out.' }, 'Art'))
      .toEqual({ title: 'Art asked for a token: github-jbarket-onterris-token', why: 'check CI on onterris/terraform-on-pond#45 (t-1586 wx seed)', ended: 'Used, ran out' });
  });
  it('a run on loom\'s machine says so, with what it was for', () => {
    expect(plain({ text: "art asked: run on loom's machine: t-1632: read-only POST rebuild + GET diff on dev-pond", outcome: 'Allowed, and used.' }, 'Art'))
      .toEqual({ title: "Art asked to run something on loom's machine", why: 't-1632: read-only POST rebuild + GET diff on dev-pond', ended: 'Used' });
  });
  it('any other approval asks for an OK', () => {
    const p = plain({ text: 'art asked: delete everything under /mnt/media/backups (426G)', outcome: 'Allowed, but it expired unused.' }, 'Art');
    expect(p.title).toBe('Art asked for your OK');
    expect(p.ended).toBe('Expired unused');
  });
  it('anything else is left as written', () => {
    expect(plain({ text: 'one joined loom', meta: 'os:linux' }, '')).toEqual({ title: 'one joined loom', why: 'os:linux', ended: undefined });
  });
});
