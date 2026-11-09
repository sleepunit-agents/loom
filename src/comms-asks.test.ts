/**
 * A thread's ask cards and chips, as pure rules (t-1979; docs/specs/comms.md, "Asks inline" and "Chips"): Allow and Deny
 * found by what they do, every other button kept, an owner-only card's buttons for its owner only; a chip's card opens
 * only where it may.
 */
import { describe, it, expect } from 'vitest';
import { askRef, conversationOfItem, isThreadAsk, openView, verdictOf } from './comms-asks.js';
import { resolveRefs } from './comms-refs.js';
import type { InboxItem } from './ui/render.js';
import type { Household, Member } from './household.js';
import type { Thread } from './comms.js';

const src = { id: 'approvals', base: '/p/approvals/' };
const item = (actions: InboxItem['actions'], more: Partial<InboxItem> = {}): InboxItem => ({ key: '0123456789abcdef', kind: 'permission', box: 'approval', attention: true, unread: false,
  text: 'OK to merge?', at: '2026-11-08T10:00:00.000Z', agent: 'art', source: src, actions, conversation: 'cv-0123456789ab', ...more });

describe('an ask\'s card', () => {
  it('Allow and Deny by their action, whatever order or tone they come in; any other choice is kept beside them', () => {
    const v = openView(item([{ action: 'deny', label: 'Deny' }, { action: 'allow', label: 'Allow once' }, { action: 'snooze', label: 'Later' }]), false, true);
    expect(v.decide?.allow.action).toBe('allow');
    expect(v.decide?.deny.action).toBe('deny');
    expect(v.buttons?.list.map((b) => b.action)).toEqual(['snooze']);
  });
  it('a card without both is its buttons, every one: never an Allow that is something else', () => {
    const v = openView(item([{ action: 'approve', label: 'Approve', tone: 'primary' }, { action: 'deny', label: 'Deny', tone: 'danger' }]), false, true);
    expect(v.decide).toBeUndefined();
    expect(v.buttons?.list.map((b) => b.action)).toEqual(['approve', 'deny']);
  });
  it('only an open ask that needs the owner, from the thread\'s own agent and conversation, is the thread\'s', () => {
    const t = { agent: 'art', conversation: 'cv-0123456789ab' };
    expect(isThreadAsk(item([]), t)).toBe(true);
    for (const more of [{ attention: false }, { box: 'done' as const }, { kind: 'answered' as const }, { kind: 'fyi' as const }, { agent: 'mark' }, { conversation: 'cv-aaaaaaaaaaaa' }]) {
      expect(isThreadAsk(item([], more), t), JSON.stringify(more)).toBe(false);
    }
  });
  it('one only the household owner may give: no button of its for an agent owner, by any name', () => {
    const v = openView(item([{ action: 'allow', label: 'Allow' }, { action: 'deny', label: 'Deny' }, { action: 'allow-24h', label: 'Allow for a day' }]), true, false);
    expect(v.decide).toBeUndefined();
    expect(v.buttons).toBeUndefined();
  });
  it('one only the household owner may give, filed as a decision rather than a permission: still no button for an agent owner', () => {
    const v = openView(item([{ action: 'allow', label: 'Allow' }, { action: 'deny', label: 'Deny' }], { kind: 'decision' }), true, false);
    expect(v.decide).toBeUndefined();
    expect(v.buttons).toBeUndefined();
    // A Needs you's own Done and Dismiss stay: they're the agent's, not the approval's.
    const n = openView(item([{ action: 'needs-done', label: 'Done' }], { kind: 'decision', reply: { action: 'needs-reply', label: 'Reply', fields: {} } }), true, false);
    expect(n.buttons?.list.map((b) => b.action)).toEqual(['needs-done']);
  });
  it('one only the household owner may give: Allow and Deny for him, neither for an agent owner', () => {
    const acts = [{ action: 'allow', label: 'Allow' }, { action: 'deny', label: 'Deny' }];
    expect(openView(item(acts), true, true).decide).toBeDefined();
    const v = openView(item(acts), true, false);
    expect(v.decide).toBeUndefined();
    expect(v.buttons).toBeUndefined();
    expect(v.ownerOnly).toBe(true);
  });
  it('a piece\'s ask binds a thread only by its conversation; a page naming one binds only a Needs you', () => {
    expect(conversationOfItem({ page: 'loom:conversation/cv-0123456789ab', source: src })).toBeUndefined();
    expect(conversationOfItem({ page: 'loom:conversation/cv-0123456789ab', source: { id: 'loom', base: '/a/art/', act: '/a/art/act/loom' },
      reply: { action: 'needs-reply', label: 'Reply', fields: {} } })).toBe('cv-0123456789ab');
    expect(conversationOfItem({ conversation: 'cv-aaaaaaaaaaaa', source: src })).toBe('cv-aaaaaaaaaaaa');
  });
  it('only the approvals piece\'s ids are approvals: another piece\'s ask is its own ref', () => {
    expect(askRef(item([{ action: 'allow', label: 'Allow', fields: { id: 'a-00000001' } }]), 'approvals')).toEqual({ ref: 'approval:a-00000001', approval: 'a-00000001' });
    expect(askRef(item([{ action: 'allow', label: 'Allow', fields: { id: 'a-00000001' } }], { source: { id: 'other', base: '/p/other/' } }), 'approvals')).toEqual({ ref: 'ask:other:a-00000001' });
  });
  it('the answer, from the action', () => {
    expect(['allow', 'deny', 'needs-reply', 'needs-done', 'needs-dismiss', 'other'].map((a) => verdictOf(a, {}))).toEqual(['allowed', 'denied', 'replied', 'done', 'dismissed', undefined]);
    expect(verdictOf('needs-answer', { answer: 'no' })).toBe('no');
    expect(verdictOf('needs-answer', { answer: 'maybe' })).toBeUndefined();
  });
});

describe('a chip\'s card', () => {
  it('opens only an allowed inside page or an https link, whatever a piece\'s feed says', async () => {
    const h = { home: '/nonexistent', agents: ['art'] } as unknown as Household;
    const m = { person: 'jonathan', agents: '*' } as unknown as Member;
    const t = { id: 'th:aaaaaaaaaa', agent: 'art', conversation: 'cv-0123456789ab' } as unknown as Thread;
    const work = [
      { title: 'Good', ref: 't-1', status: 'Open', url: '/p/tasks/task/t-1', from: 'tasks' },
      { title: 'Sneaky', ref: 't-2', status: 'Open', url: '/\\evil.com', from: 'tasks' },
      { title: 'Off', ref: 't-3', status: 'Open', url: '/p/tasks/task/t-3?next=//evil', from: 'tasks' },
      { title: 'PR', ref: 'github:acme/app#3', status: 'Merged', url: 'javascript:alert(1)', from: 'changes' },
      { title: 'Elsewhere', ref: 't-4', status: 'Open', url: 'https://tracker.example/t-4', from: 'tasks' },
      { title: 'Script', ref: 't-5', status: 'Open', url: 'javascript:alert(1)', from: 'tasks' },
      { title: 'Plain', ref: 't-6', status: 'Open', url: 'http://tracker.example/t-6', from: 'tasks' },
    ];
    const r = await resolveRefs(h, {}, t, m, ['t-1', 't-2', 't-3', 'github:acme/app#3', 't-4', 't-5', 't-6'], {
      pieces: async () => [], work: async () => ({ items: work }), asks: async () => [], pending: async () => [] });
    expect(r['t-1']).toMatchObject({ title: 'Good', page: 'p/tasks/task/t-1' });
    expect(r['t-2']).toMatchObject({ title: 'Sneaky' });
    expect(r['t-2']).not.toHaveProperty('page');
    expect(r['t-3']).not.toHaveProperty('page');
    expect(r['github:acme/app#3']).toMatchObject({ title: 'PR', href: 'https://github.com/acme/app/issues/3' });
    expect(r['t-4']).toMatchObject({ href: 'https://tracker.example/t-4' });
    for (const x of ['t-5', 't-6']) { expect(r[x], x).not.toHaveProperty('href'); expect(r[x], x).not.toHaveProperty('page'); }
  });
});

it('runtime provenance shows descendant asks only for the same agent and an already visible open item', () => {
  const t = { agent: 'art', conversation: 'cv-0123456789ab' } as Thread;
  const origins = { 'cv-00000000000f': t.conversation };
  const child = item([], { conversation: 'cv-00000000000f' });
  expect(isThreadAsk(child, t)).toBe(false);
  expect(isThreadAsk(child, t, origins)).toBe(true);
  for (const more of [{ agent: 'mark' }, { box: 'done' as const }, { attention: false }, { kind: 'answered' as const }]) {
    expect(isThreadAsk({ ...child, ...more }, t, origins)).toBe(false);
  }
});
