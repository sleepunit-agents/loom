/**
 * The Inbox's folders (t-1925): which folder each item files under (one rule, the server's: render.ts inboxBox), and the
 * old folder addresses (`?f=`, before t-1925) landing on the new ones.
 */
import { describe, it, expect } from 'vitest';
import { folderOf, inboxBox, INBOX_FOLDERS } from './render.js';

describe('the Inbox\'s folders', () => {
  it('are the approved mock\'s, in its order', () => {
    expect(INBOX_FOLDERS.map((f) => f.label)).toEqual(['Needs you', 'Questions', 'Approvals', 'Alerts', 'Memory reviews', 'Done']);
  });

  it('file each item by what it wants from the owner; history is Done', () => {
    const open = { attention: true };
    expect(inboxBox({ ...open, kind: 'permission' })).toBe('approval');
    expect(inboxBox({ ...open, kind: 'alert', approval: {} })).toBe('approval');
    expect(inboxBox({ ...open, kind: 'alert', memory: true })).toBe('memory');
    // Filed, not counted: still its folder, never Done.
    expect(inboxBox({ attention: false, kind: 'decision', memory: true })).toBe('memory');
    expect(inboxBox({ attention: false, kind: 'decision' })).toBe('question');
    for (const kind of ['decision', 'reply', 'todo'] as const) expect(inboxBox({ ...open, kind })).toBe('question');
    // A conversation's Needs you is an alert by kind, but it asks something: a question.
    expect(inboxBox({ ...open, kind: 'alert', reply: {} })).toBe('question');
    expect(inboxBox({ ...open, kind: 'alert', needs: {} })).toBe('question');
    expect(inboxBox({ ...open, kind: 'alert' })).toBe('alert');
    expect(inboxBox({ attention: false, kind: 'answered' })).toBe('done');
    expect(inboxBox({ attention: false, kind: 'fyi' })).toBe('done');
  });

  it('old addresses land on the new folders; anything else is Needs you', () => {
    expect(['permission', 'decision', 'reply', 'todo', 'fyi', 'answered', 'alert', 'needs', 'memory', 'nope', undefined].map(folderOf))
      .toEqual(['approval', 'question', 'question', 'question', 'done', 'done', 'alert', 'needs', 'memory', 'needs', 'needs']);
  });
});
