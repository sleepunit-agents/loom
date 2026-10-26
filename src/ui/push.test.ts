import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './sessions.js';
import { askKey, pushSub, watch, WATCH_S } from './push.js';

const sub = (host = 'fcm.googleapis.com', path = '/fcm/send/abc') => ({
  endpoint: `https://${host}${path}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
});

describe('push: who loom will send to', () => {
  it('only https endpoints on a known push service, with real-looking keys', () => {
    for (const h of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'wns2-by3p.notify.windows.com']) expect(pushSub(sub(h))).not.toBeNull();
    expect(pushSub({ ...sub(), endpoint: 'http://fcm.googleapis.com/x' })).toBeNull();
    expect(pushSub(sub('127.0.0.1'))).toBeNull();
    expect(pushSub(sub('fcm.googleapis.com.evil.example'))).toBeNull();
    expect(pushSub({ ...sub(), endpoint: 'https://fcm.googleapis.com:8443/x' })).toBeNull();
    expect(pushSub({ ...sub(), keys: { p256dh: 'x', auth: 'y' } })).toBeNull();
    expect(pushSub('nope')).toBeNull();
  });
});

describe('push: the watch', () => {
  let dir: string;
  let store: SessionStore;
  let session: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-push-'));
    store = new SessionStore(dir);
    session = store.create(Buffer.alloc(32, 7));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const asks = (keys: string[]) => async () => keys.map((k) => ({ key: k, title: `Your call · ${k}`, body: `ask ${k}` }));

  it('the first watch only records; another listener in the same minute gets nothing', async () => {
    store.addPushSub(session, sub());
    const sent: string[] = [];
    const send = async (_s: unknown, payload: string) => { sent.push(payload); return {} as never; };
    expect(await watch(store, asks(['a']), 'mailto:x', send)).toBe(0);   // the backlog: recorded, not announced
    expect(sent).toEqual([]);
    expect(store.takePushWatch(WATCH_S)).toBeNull();                      // loom's other listeners, this minute
  });

  it('end to end across watches: a new ask goes out once, a gone subscription is forgotten', async () => {
    store.addPushSub(session, sub());
    store.addPushSub(session, sub('updates.push.services.mozilla.com', '/wpush/v2/gone'));
    const sent: string[] = [];
    const send = async (s: { endpoint: string }, payload: string) => {
      if (s.endpoint.includes('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      sent.push(JSON.parse(payload).url);
      return {} as never;
    };
    const run = async (keys: string[]) => {
      // Each run is its own minute: clear the watch so this process takes it.
      const f = JSON.parse(readFileSync(join(dir, 'ui-sessions.json'), 'utf8'));
      if (f.push) { delete f.push.tickAt; writeFileSync(join(dir, 'ui-sessions.json'), JSON.stringify(f)); }
      return watch(store, asks(keys), 'mailto:x', send);
    };
    await run(['a']);                    // seed
    expect(sent).toEqual([]);
    await run(['a', 'b']);               // b is new
    expect(sent).toEqual(['/#ask-b']);
    await run(['a', 'b']);               // nothing new
    expect(sent).toEqual(['/#ask-b']);
    const w = store.takePushWatch(0);
    expect(w!.subs.map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/abc']);   // the 410 one is gone
  });

  it('a subscription goes with its session: sign-out, or a session that no longer exists', () => {
    store.addPushSub(session, sub());
    store.addPushSub('not-a-session', sub('fcm.googleapis.com', '/other'));   // ignored: no such session
    expect(store.takePushWatch(0)!.subs).toHaveLength(1);
    store.delete(session);
    expect(store.takePushWatch(0)!.subs).toHaveLength(0);
  });

  it('an ask\'s key is stable, and differs by source, text and page', () => {
    const a = { source: { id: 'tasks' }, text: 'Review the rubric', page: 'task/t-1' };
    expect(askKey(a)).toBe(askKey({ ...a }));
    expect(new Set([askKey(a), askKey({ ...a, text: 'x' }), askKey({ ...a, source: { id: 'clock' } }), askKey({ ...a, page: undefined })]).size).toBe(4);
  });
});
