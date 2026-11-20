import { expect, it } from 'vitest';
import { bodyReach, hasFileTools } from './harness-traits.js';
import type { WorkerRunPolicy } from './worker.js';

const policy = (deniedTools: WorkerRunPolicy['deniedTools'], guest = false): WorkerRunPolicy =>
  ({ deniedTools, people: guest ? [{ kind: 'outside', person: 'someone', tier: 1 }] : [{ kind: 'person', person: 'owner', tier: null }], mail: [], word: guest ? 'others' : 'owners' });

it('says a body has file tools only on a machine that gives it the harness\'s own, and only while reading files is not denied it', () => {
  // The one answer behind both of loom's file doors: attachments written for the body, and a file it names for a post.
  expect(hasFileTools('all', undefined)).toBe(true);
  expect(hasFileTools('loom', undefined)).toBe(false);
  expect(hasFileTools('all', policy([{ pattern: 'Bash(*)', guestsOnly: false }, { pattern: 'ReadMcpResource', guestsOnly: false }]))).toBe(true);
  for (const pattern of ['Read', ' Read ', 'Read(*)', 'Read(/home/**)']) {
    expect(hasFileTools('all', policy([{ pattern, guestsOnly: false }])), pattern).toBe(false);
    // Denied to guests' bodies only: it counts when a guest is in the room, and not otherwise.
    expect(hasFileTools('all', policy([{ pattern, guestsOnly: true }], true)), pattern).toBe(false);
    expect(hasFileTools('all', policy([{ pattern, guestsOnly: true }])), pattern).toBe(true);
  }
  expect(hasFileTools('loom', policy([]))).toBe(false);
  // A job on anybody else's word has the reach `loom` on every machine (bodyReach), and so no file tools, with nothing denied.
  expect(hasFileTools(bodyReach('all', policy([], true)), policy([], true))).toBe(false);
  expect(hasFileTools(bodyReach('all', policy([])), policy([]))).toBe(true);
});
