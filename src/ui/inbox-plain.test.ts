import { describe, expect, it } from 'vitest';
import { bits, duration, plain } from '../../web/src/plain';

// The texts as the approvals and secrets pieces write them (live Inbox, 2026-10-29).
describe('the Inbox in plain words', () => {
  it('a secret request says which token, the agent\'s why, and the answer taken apart', () => {
    expect(plain({ text: 'art asked for github-jbarket-onterris-token: “check CI on onterris/terraform-on-pond#45 (t-1586 wx seed)”',
      outcome: 'Allowed for 480 min (by the policy); it ran out.' }, 'Art')).toEqual({
      title: 'Art asked for a token: github-jbarket-onterris-token', head: 'Art asked for a token', subject: 'github-jbarket-onterris-token',
      why: 'check CI on onterris/terraform-on-pond#45 (t-1586 wx seed)', ended: 'Used, ran out',
      answer: { verdict: 'Allowed', by: 'your standing rule', for: '8 hours' } });
  });
  it('a run on loom\'s machine says so, with what it was for and who allowed it', () => {
    const p = plain({ text: "art asked: run on loom's machine: t-1632: read-only POST rebuild + GET diff on dev-pond", outcome: 'Allowed, and used. (Allowed by jonathan-barket.)' }, 'Art');
    expect(p).toMatchObject({ title: "Art asked to run something on loom's machine", why: 't-1632: read-only POST rebuild + GET diff on dev-pond', ended: 'Used',
      answer: { verdict: 'Allowed', by: 'Jonathan Barket' } });
  });
  it('any other approval asks for an OK', () => {
    const p = plain({ text: 'art asked: delete everything under /mnt/media/backups (426G)', outcome: 'Allowed, but it expired unused.' }, 'Art');
    expect(p.title).toBe('Art asked for your OK');
    expect(p.ended).toBe('Expired unused');
    expect(p.answer).toEqual({ verdict: 'Allowed' });
  });
  it('a waiting ask reads like an answered one, in the present tense', () => {
    expect(plain({ text: "art asks: run on loom's machine: Read-only DNS health check of pihole" }, 'Art').title).toBe("Art asks to run something on loom's machine");
    expect(plain({ text: 'art asks for slack-onterris.env: “reply to Pat”' }, 'Art')).toMatchObject({ head: 'Art asks for a secret', subject: 'slack-onterris.env', why: 'reply to Pat' });
  });
  it('anything else is left as written', () => {
    expect(plain({ text: 'one joined loom', meta: 'os:linux' }, '')).toMatchObject({ title: 'one joined loom', head: 'one joined loom', why: 'os:linux', ended: undefined, answer: undefined });
  });
  it('a duration reads as people say it', () => {
    expect([duration(15), duration(60), duration(480), duration(90)]).toEqual(['15 minutes', '1 hour', '8 hours', '1h 30m']);
  });
  it('the why is cut at its tasks, pull requests and files', () => {
    expect(bits('verify onterris/on-pond#178 for t-1099 round 4. Brief: ~/Art/notes/x.md.')).toEqual([
      { t: 'text', s: 'verify ' }, { t: 'pr', repo: 'onterris/on-pond', n: '178' }, { t: 'text', s: ' for ' }, { t: 'task', id: 't-1099' },
      { t: 'text', s: ' round 4. Brief: ' }, { t: 'path', s: '~/Art/notes/x.md' }, { t: 'text', s: '.' }]);
  });
});
