import { describe, expect, it } from 'vitest';
import { bits, duration, openItem, opensTo, plain } from '../../web/src/plain';

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

// Where an item opens, from the Inbox's row and from Home's banner alike (Jonathan, 2026-11-02: the banner went to the
// Inbox, and the task's sheet said nothing he didn't know).
describe('an item opens to the item itself', () => {
  const key = '0123456789abcdef';
  it('a task opens on its own page (the tasks piece\'s t-1273), not the Inbox', () => {
    expect(opensTo({ key, kind: 'todo', page: 'task/t-1273' })).toEqual({ page: 'task/t-1273' });
  });
  it('an item with buttons opens on them: its sheet, at its own address in the Inbox', () => {
    expect(opensTo({ key, kind: 'decision', page: 'loom:a/art/mind', actions: [{ action: 'ratify' }] })).toEqual({ sheet: `/inbox?i=${key}` });
  });
  it('an item with no page of its own, or only its piece\'s front page, opens its sheet', () => {
    expect(opensTo({ key, kind: 'alert' })).toEqual({ sheet: `/inbox?i=${key}` });
    expect(opensTo({ key, kind: 'alert', page: '' })).toEqual({ sheet: `/inbox?i=${key}` });
  });
  it('an answered one is history, told in its sheet', () => {
    expect(opensTo({ key, kind: 'answered', page: 'request/r-1' })).toEqual({ sheet: `/inbox?i=${key}` });
  });
  it('opening an unread item reads it first, then goes to its own page; a read one just goes', async () => {
    const log: string[] = [];
    const to = { read: async (k: string) => { log.push(`read ${k}`); }, page: (p: string) => log.push(`page ${p}`), go: (h: string) => log.push(`go ${h}`) };
    await openItem({ key, kind: 'todo', page: 'task/t-1273', unread: true }, to);
    expect(log).toEqual([`read ${key}`, 'page task/t-1273']);
    log.length = 0;
    await openItem({ key, kind: 'todo', page: 'task/t-1273', unread: false }, to);
    expect(log).toEqual(['page task/t-1273']);
  });
  it('a sheet from elsewhere is its /inbox?i= address, which reads it; one in the Inbox is read, then opened', async () => {
    const log: string[] = [];
    const to = { read: async (k: string) => { log.push(`read ${k}`); }, page: (p: string) => log.push(`page ${p}`), go: (h: string) => log.push(`go ${h}`) };
    await openItem({ key, kind: 'decision', actions: [{}], unread: true }, to);
    expect(log).toEqual([`go /inbox?i=${key}`]);
    log.length = 0;
    await openItem({ key, kind: 'decision', actions: [{}], unread: true }, { ...to, sheet: () => log.push('sheet') });
    expect(log).toEqual([`read ${key}`, 'sheet']);
  });
  it('a read that fails still opens the item', async () => {
    const log: string[] = [];
    await openItem({ key, kind: 'todo', page: 'task/t-1', unread: true }, { read: () => Promise.reject(new Error('offline')), page: (p) => log.push(p), go: () => {} });
    expect(log).toEqual(['task/t-1']);
  });
});
