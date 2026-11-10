/**
 * A Needs you alert you can act on (t-1778): a conversation digest's `needs_owner` (and `needs_owner_href`) is an
 * Inbox alert whose sheet has Reply, Done and Dismiss. Each is posted here exactly as the sheet posts it, from the
 * item's own `reply` and `actions`: to the agent's actions (/a/<agent>/act/loom), with the page's form token.
 *
 * Reply goes through a stub runtime piece (role runtime, offering `delivery`), which appends what it's handed to
 * $LOOM_HOME/runtime-calls.jsonl: the owner's words reach the runtime as a person's message on the conversation's
 * own venue and place (here `wake`, a venue no piece may deliver a person's message on), from core (`source: loom`).
 */
import { requestTrace } from './request-trace.fixture.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { createConversationTables, parseDigest, recordTurn, writeDigest, ConversationError } from '../backends/conversations.js';
import { clearPieceCache } from './pieces.js';
import { closeAllBackends } from '../backends/index.js';

const RUNTIME_BIN = `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.argv[2] === 'grants') return console.log('{"allow":true}');
  const f = process.env.LOOM_HOME + '/runtime-calls.jsonl';
  const stdin = JSON.parse(input);
  fs.appendFileSync(f, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');
  // A body that's slow to take it (the live one, 2026-11-04: "its body is still starting", 3.5 s).
  setTimeout(() => console.log(JSON.stringify({ conversation: 'cv-0123456789ab', seq: 2, body: 'resumed' })), /SLOW/.test(stdin.text ?? '') ? 800 : 0);
});
`;

function household(): Household {
  const home = mkdtempSync(join(tmpdir(), 'loom-needs-alert-'));
  for (const a of ['art', 'mark']) {
    mkdirSync(join(home, 'agents', a), { recursive: true });
    writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), a === 'art' ? '# Art E Fish\n' : '# Visual Mark\n');
    const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
    createConversationTables(db);
    db.close();
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({
    v: 1, agents: ['art', 'mark'], default: 'art', github: 'sleepunit-agents', members: [{ person: 'jonathan', role: 'owner', agents: '*' }],
  }));
  const loom = parseLoomBlock({ role: 'runtime', delivery: ['loom-runtime', 'deliver', '--json'], venues: { relay: { label: 'Relay', kind: 'agent' } } }, 'runtime', ['loom-runtime']);
  if (typeof loom === 'string') throw new Error(loom);
  const dir = join(home, 'pieces', 'runtime');
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name: 'runtime', source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: 'runtime', version: '1', installed: 'x',
    bins: ['loom-runtime'], loom: { settings: [], services: [], ...loom } }));
  writeFileSync(join(dir, 'current', 'cli'), RUNTIME_BIN);
  chmodSync(join(dir, 'current', 'cli'), 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  symlinkSync(join(dir, 'current', 'cli'), join(home, 'pieces', 'bin', 'loom-runtime'));
  return loadHousehold(home)!;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any;

describe('a Needs you alert: its sheet replies, marks done and dismisses', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  let owner: string;
  let art: string;
  let conv: string;
  const saved = process.env.LOOM_HOME;

  beforeEach(async () => {
    h = household();
    process.env.LOOM_HOME = h.home;
    clearPieceCache();
    owner = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    art = agentDir(h, 'art');
    // A wake's conversation, as the live one (2026-11-03): a lane run that needs Jonathan to merge a PR.
    conv = recordTurn(art, 'art', { venue: 'wake', place: 'lane:making', label: 't-1735: bridge digest', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, {
      summary: 'Opened art#68.', needs_owner: 'Review/merge art#68 (Slack brief: on-behalf requests as digests, two-way door)',
      needs_owner_href: 'https://github.com/sleepunit-agents/art/pull/68',
    });
    handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.close();
    await closeAllBackends();
    clearPieceCache();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(h.home, { recursive: true, force: true });
  });

  const login = async (request = fetch) => {
    const r = await request(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(owner)}`, redirect: 'manual' });
    return (r.headers.get('set-cookie') ?? '').split(';')[0];
  };
  const inbox = async (cookie: string, request = fetch): Promise<Data> => (await request(`${base}/inbox`, { headers: { cookie, accept: 'application/json' } })).json();
  const alertOf = (d: Data): Data => (d.items as Data[]).find((i) => i.kind === 'alert' && /needs you/.test(i.text));
  /** What the sheet does with one of its buttons (blocks.tsx ActButton, inbox.tsx ReplyBox): post the action, as fetch. */
  const press = async (cookie: string, d: Data, item: Data, action: string, fields: Record<string, string>, request = fetch) => {
    const r = await request(`${base}${item.source.act}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
      body: new URLSearchParams({ _csrf: d.ctx.csrf, _action: action, _path: 'loom:inbox', ...fields }).toString(),
    });
    expect(r.status).toBe(200);
    return r.json() as Promise<{ ok: boolean; message: string }>;
  };
  const calls = (): Data[] => {
    const f = join(h.home, 'runtime-calls.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };

  it('the alert opens as its sheet, with the whole of it, its link, its agent to reply to, Done and Dismiss', async () => {
    const d = await inbox(await login());
    const a = alertOf(d);
    expect(a).toMatchObject({
      kind: 'alert', attention: true, agent: 'art', text: 'Art E Fish needs you: Review/merge art#68 (Slack brief: on-behalf requests as digests, two-way door)',
      meta: 't-1735: bridge digest · Wake', page: `loom:conversation/${conv}`, href: 'https://github.com/sleepunit-agents/art/pull/68',
      source: { id: 'loom', act: '/a/art/act/loom' }, reply: { action: 'needs-reply', label: 'Reply to Art E Fish' },
    });
    expect(a.actions.map((b: Data) => b.label)).toEqual(['Done', 'Dismiss']);
    // The bare art#68 links under the household's GitHub owner.
    expect(d.github).toBe('sleepunit-agents');
  });

  it('Reply delivers the owner\'s words to that conversation as their own message, and answers the ask', async () => {
    const cookie = await login();
    const d = await inbox(cookie);
    const a = alertOf(d);
    const r = await press(cookie, d, a, a.reply.action, { ...a.reply.fields, text: 'Merged; go ahead with t-1736.' });
    expect(r).toMatchObject({ ok: true, message: 'Sent. Art E Fish has it.' });
    const [call] = calls();
    expect(call.argv).toEqual(['deliver', '--json']);
    expect(call.stdin).toMatchObject({
      agent: 'art', venue: 'wake', place: 'lane:making', label: 't-1735: bridge digest', from: { kind: 'person', slug: 'jonathan' },
      kind: 'message', text: 'Merged; go ahead with t-1736.', source: 'loom',
    });
    expect(call.stdin.id).toMatch(/^needs:dg-/);
    // Answered: not in Needs you any more; in the history, as replied, with no words kept.
    const after = await inbox(cookie);
    expect(alertOf(after)).toBeUndefined();
    const done = (after.items as Data[]).find((i) => i.kind === 'answered');
    expect(done).toMatchObject({ outcome: 'You replied', attention: false, href: 'https://github.com/sleepunit-agents/art/pull/68' });
    expect(JSON.stringify(after)).not.toContain('go ahead with t-1736');
    // Its toast left no FYI as well.
    expect((after.items as Data[]).filter((i) => i.kind === 'fyi')).toEqual([]);
  });

  it('an empty reply is refused, and reaches nobody', async () => {
    const cookie = await login();
    const d = await inbox(cookie);
    const a = alertOf(d);
    expect(await press(cookie, d, a, a.reply.action, { ...a.reply.fields, text: '   ' })).toMatchObject({ ok: false });
    expect(calls()).toEqual([]);
    expect(alertOf(await inbox(cookie))).toBeDefined();
  });

  it('Done answers it: out of Needs you, in the history as Done', async () => {
    const trace = requestTrace();
    const cookie = await login(trace.fetch);
    const d = await inbox(cookie, trace.fetch);
    const a = alertOf(d);
    const done = a.actions.find((b: Data) => b.label === 'Done');
    expect(await press(cookie, d, a, done.action, done.fields, trace.fetch)).toMatchObject({ ok: true });
    const after = await inbox(cookie, trace.fetch);
    expect(alertOf(after)).toBeUndefined();
    expect((after.items as Data[]).find((i) => i.kind === 'answered')).toMatchObject({ outcome: 'Done', text: a.text });
    expect(calls()).toEqual([]);
  });

  it('Dismiss clears it and keeps nothing', async () => {
    const cookie = await login();
    const d = await inbox(cookie);
    const a = alertOf(d);
    const dismiss = a.actions.find((b: Data) => b.label === 'Dismiss');
    expect(await press(cookie, d, a, dismiss.action, dismiss.fields)).toMatchObject({ ok: true, message: 'Dismissed.' });
    const after = await inbox(cookie);
    expect(alertOf(after)).toBeUndefined();
    expect((after.items as Data[]).filter((i) => i.kind === 'answered')).toEqual([]);
  });

  it('a newer digest that still needs the owner asks again; answering the old one then is refused', async () => {
    const cookie = await login();
    const d = await inbox(cookie);
    const a = alertOf(d);
    writeDigest(art, { conversation: conv, run: 'r2' }, { summary: 'Still waiting.', needs_owner: 'Merge art#69 now' }, new Date(Date.now() + 1000));
    const done = a.actions.find((b: Data) => b.label === 'Done');
    expect(await press(cookie, d, a, done.action, done.fields)).toMatchObject({ ok: false, message: expect.stringMatching(/isn.t open any more/) });
    expect(await press(cookie, d, a, a.reply.action, { ...a.reply.fields, text: 'too late' })).toMatchObject({ ok: false });
    expect(calls()).toEqual([]);
    expect(alertOf(await inbox(cookie)).text).toBe('Art E Fish needs you: Merge art#69 now');
  });
});

describe('a yes/no Needs you: Yes and No answer it, and nothing typed is lost to Done', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  let owner: string;
  let art: string;
  let conv: string;
  const saved = process.env.LOOM_HOME;
  const ASK = 'Can you review and merge the fix that catches wake bodies that die without finishing?';

  beforeEach(async () => {
    h = household();
    process.env.LOOM_HOME = h.home;
    clearPieceCache();
    owner = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    art = agentDir(h, 'art');
    // The live one Jonathan answered on 2026-11-04 (t-1824), as written: an object with if_yes and if_no.
    conv = recordTurn(art, 'art', { venue: 'wake', place: 'lane:night', label: 't-1824: dead rounds', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, {
      summary: 'Opened art#69.', needs_owner: { ask: ASK, why: 'Two of the backup-setup bodies died silently yesterday.',
        if_yes: 'I check the hourly checker can reach loom, then close it out.', if_no: 'Dead bodies keep going unnoticed until the nightly reflect.',
        refs: ['t-1824', 'sleepunit-agents/art#69'], href: 'https://github.com/sleepunit-agents/art/pull/69' },
    });
    handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.close();
    await closeAllBackends();
    clearPieceCache();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(h.home, { recursive: true, force: true });
  });

  const login = async (request = fetch) => {
    const r = await request(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(owner)}`, redirect: 'manual' });
    return (r.headers.get('set-cookie') ?? '').split(';')[0];
  };
  const inbox = async (cookie: string, request = fetch): Promise<Data> => (await request(`${base}/inbox`, { headers: { cookie, accept: 'application/json' } })).json();
  const alertOf = (d: Data): Data => (d.items as Data[]).find((i) => i.kind === 'alert' && i.attention);
  /** What the sheet posts (inbox.tsx useAnswer, blocks.tsx ActButton): the action, with the item's reply fields. */
  const press = async (cookie: string, d: Data, item: Data, action: string, fields: Record<string, string>, request = fetch) => {
    const r = await request(`${base}${item.source.act}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
      body: new URLSearchParams({ _csrf: d.ctx.csrf, _action: action, _path: 'loom:inbox', ...fields }).toString(),
    });
    expect(r.status).toBe(200);
    return r.json() as Promise<{ ok: boolean; message: string }>;
  };
  const calls = (): Data[] => {
    const f = join(h.home, 'runtime-calls.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };

  it('is a yes/no question: it has if_yes and if_no, so its sheet answers Yes and No', async () => {
    const a = alertOf(await inbox(await login()));
    expect(a.needs).toMatchObject({ answers: 'yes-no', if_yes: expect.any(String), if_no: expect.any(String) });
  });

  it('Yes delivers "Yes" and the ask\'s own if_yes line to the conversation, and answers it: "You said yes"', async () => {
    const cookie = await login();
    const d = await inbox(cookie);
    const a = alertOf(d);
    expect(await press(cookie, d, a, 'needs-answer', { ...a.reply.fields, answer: 'yes' })).toMatchObject({ ok: true, message: expect.stringMatching(/^Sent\./) });
    const [call] = calls();
    expect(call.stdin).toMatchObject({ venue: 'wake', place: 'lane:night', from: { kind: 'person', slug: 'jonathan' }, kind: 'message',
      text: `Yes, to: ${ASK}\nIf yes, you said: I check the hourly checker can reach loom, then close it out.` });
    const after = await inbox(cookie);
    expect(alertOf(after)).toBeUndefined();
    expect((after.items as Data[]).find((i) => i.kind === 'answered')).toMatchObject({ outcome: 'You said yes', text: ASK });
  });

  it('No delivers "No" and its if_no line: "You said no"', async () => {
    const cookie = await login();
    const d = await inbox(cookie);
    const a = alertOf(d);
    expect(await press(cookie, d, a, 'needs-answer', { ...a.reply.fields, answer: 'no' })).toMatchObject({ ok: true });
    expect(calls()[0].stdin.text).toBe(`No, to: ${ASK}\nIf no, you said: Dead bodies keep going unnoticed until the nightly reflect.`);
    expect((await inbox(cookie)).items.find((i: Data) => i.kind === 'answered')).toMatchObject({ outcome: 'You said no' });
  });

  it('an answer other than yes or no is refused, and reaches nobody', async () => {
    const cookie = await login();
    const d = await inbox(cookie);
    const a = alertOf(d);
    expect(await press(cookie, d, a, 'needs-answer', { ...a.reply.fields, answer: 'maybe' })).toMatchObject({ ok: false });
    expect(calls()).toEqual([]);
    expect(alertOf(await inbox(cookie))).toBeDefined();
  });

  it('an ask marked answers: "words" has no Yes or No, and refuses one', async () => {
    writeDigest(art, { conversation: conv, run: 'r2' }, { summary: 'Asked who reviews.', needs_owner: {
      ask: 'Should I hand my two fixes to Gabe or Mark to review, or close them?', answers: 'words',
      if_yes: 'Reply with who reviews them.', if_no: 'Reply close and I close both.' } }, new Date(Date.now() + 1000));
    const cookie = await login();
    const d = await inbox(cookie);
    const a = alertOf(d);
    expect(a.needs.answers).toBe('words');
    expect(await press(cookie, d, a, 'needs-answer', { ...a.reply.fields, answer: 'yes' })).toMatchObject({ ok: false, message: expect.stringMatching(/isn't a yes or no/) });
    expect(calls()).toEqual([]);
  });

  it('a plain string ask is answered in words, never Yes or No', async () => {
    writeDigest(art, { conversation: conv, run: 'r2' }, { summary: 's', needs_owner: 'Merge art#69 when you can' }, new Date(Date.now() + 1000));
    const a = alertOf(await inbox(await login()));
    expect(a.needs.answers).toBe('words');
  });

  it('Done pressed while a reply is on its way: the words still reached the agent, so the reply says Sent, not that they didn\'t', async () => {
    // 2026-11-04, live: a reply took 3.5 s ("its body is still starting"), Done landed 1 s in and answered the ask, and
    // the reply then failed on the already-answered ask, so the sheet said it hadn't gone. It had.
    const cookie = await login();
    const d = await inbox(cookie);
    const a = alertOf(d);
    const reply = press(cookie, d, a, a.reply.action, { ...a.reply.fields, text: 'SLOW yes, merge it' });
    await new Promise((r) => setTimeout(r, 300));
    const done = a.actions.find((b: Data) => b.label === 'Done');
    expect(await press(cookie, d, a, done.action, done.fields)).toMatchObject({ ok: true });
    expect(await reply).toMatchObject({ ok: true, message: expect.stringMatching(/^Sent\./) });
    expect(calls().map((c) => c.stdin.text)).toEqual(['SLOW yes, merge it']);
  });
});

describe('needs_owner_href', () => {
  it('is an https URL, only with needs_owner', () => {
    expect(parseDigest({ summary: 's', needs_owner: 'merge it', needs_owner_href: 'https://github.com/o/r/pull/1' }).needs_owner_href).toBe('https://github.com/o/r/pull/1');
    expect(parseDigest({ summary: 's' }).needs_owner_href).toBeNull();
    for (const bad of ['http://github.com/o/r/pull/1', 'javascript:alert(1)', 'https://u:p@x.com/', 'not a url']) {
      expect(() => parseDigest({ summary: 's', needs_owner: 'x', needs_owner_href: bad })).toThrow(ConversationError);
    }
    expect(() => parseDigest({ summary: 's', needs_owner_href: 'https://x.com/' })).toThrow(/goes with needs_owner/);
  });
});
