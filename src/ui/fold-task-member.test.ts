import { expect, it, vi } from 'vitest';
import type { Household } from '../household.js';
import type { HomeAsk } from './render.js';

const cv = 'cv-0123456789ab';
vi.mock('../comms.js', async (original) => ({ ...await original<typeof import('../comms.js')>(),
  threadMembers: () => ({ live: new Map([['cv-0123456789ab', { member: 'sam', agent: 'art' }]]), deleted: new Map() }),
}));
vi.mock('../backends/conversations.js', async (original) => ({ ...await original<typeof import('../backends/conversations.js')>(),
  openNeeds: () => [{ conversation: { id: 'cv-0123456789ab', venue: 'comms', place: 'thread' },
    digest: { id: 'dg-test', needs: { ask: 'Use the spare?', why: 'Private explanation', if_yes: 'Private outcome', refs: [], waits_on: { task: 't-1' } } } }],
}));
import { conversationAsks, foldTaskAsks } from './handler.js';

it('filters a member’s digest before its private fallback can enter a household task card', () => {
  const h = { home: '/nonexistent', agentsDir: '/nonexistent/agents', agents: ['art'],
    members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] }] } as Household;
  const task = { text: 'Use the spare?', agent: 'art', page: 'task/t-1', source: { id: 'tasks', base: '/p/tasks/' } } as HomeAsk;
  const owner = conversationAsks(h, { person: 'jonathan', householdOwner: true });
  expect(owner).toEqual([]);
  expect(foldTaskAsks([task, ...owner], 'tasks')).toEqual([task]);
  const member = conversationAsks(h, { person: 'sam', householdOwner: false });
  expect(member).toHaveLength(1);
  expect(member[0].page).toBe(`loom:conversation/${cv}`);
  expect(foldTaskAsks([task, ...member], 'tasks')[0].needs?.why).toBe('Private explanation');
});
