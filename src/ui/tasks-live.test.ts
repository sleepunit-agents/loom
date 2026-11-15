/**
 * The tasks' live records in the window (web/src/tasks-live.ts, tasks-pages.ts, comms-work.tsx; t-2029): which pages read
 * them, when a set read in pages is whole, what moved, and which moves a thread's work panel reads again for.
 */
import { describe, it, expect } from 'vitest';
import { movedKeys, recordsOf } from '../../web/src/tasks-live';
import { pulseOf, tasksPageKind } from '../../web/src/tasks-pages';

import type { Rec, ViewState } from '../../web/src/collections/runtime';

const rec = (id: string, more: Record<string, unknown> = {}): Rec => ({ key: `tasks/task/${id}`, ...more });
const state = (keys: string[], o: Partial<ViewState> = {}): ViewState => ({ keys, withheld: [], status: 'live', more: false, ...o });

describe('the tasks\' live records', () => {
  it('a Tasks work page is theirs alone; a task\'s own page and a project\'s read them too; nothing else does', () => {
    expect(['/p/tasks', '/p/tasks?sort=new&show=open', '/p/tasks/', '/a/art/p/tasks'].map(tasksPageKind)).toEqual(['live', 'live', 'live', 'live']);
    expect(['/p/tasks/task/t-12', '/projects', '/projects/art/app', '/projects/app?x=1'].map(tasksPageKind)).toEqual(['also', 'also', 'also', 'also']);
    expect(['/', '/p/tasksx', '/inbox', '/a/art/p/approvals', '/projectsx'].map(tasksPageKind)).toEqual([null, null, null, null, null]);
  });

  it('a set is whole once it\'s live with no next page, and inside the window core keeps current', () => {
    const records = new Map([[rec('t-1').key, rec('t-1')]]);
    expect(recordsOf(state(['tasks/task/t-1']), records)?.size).toBe(1);
    expect(recordsOf(state(['tasks/task/t-1'], { more: true }), records)).toBeNull();
    expect(recordsOf(state(['tasks/task/t-1'], { status: 'loading' }), records)).toBeNull();
    expect(recordsOf(state(['tasks/task/t-1'], { status: 'stale' }), records)).toBeNull();
    expect(recordsOf(state(Array.from({ length: 1000 }, (_, i) => `tasks/task/t-${i}`)), records)).toBeNull();
  });

  it('what moved: a new copy, a new key, a key gone; never one left as it was', () => {
    const a = rec('t-1'), b = rec('t-2'), c = rec('t-3');
    const was = new Map([[a.key, a], [b.key, b]]);
    expect([...movedKeys(was, new Map([[a.key, a], [b.key, { ...b }], [c.key, c]]))].sort()).toEqual([b.key, c.key]);
    expect([...movedKeys(was, new Map([[a.key, a]]))]).toEqual([b.key]);
    expect(movedKeys(was, new Map(was)).size).toBe(0);
  });

  it('Changes\' pages move with the changes, a project\'s with both, a Tasks page with the tasks', () => {
    expect(['/p/changes', '/p/changes/c/github/acme/app/3', '/a/art/p/changes'].map(pulseOf)).toEqual(['changes', 'changes', 'changes']);
    expect(['/p/changes', '/p/changes/c/github/acme/app/3'].map(tasksPageKind)).toEqual(['also', 'also']);
    expect(['/projects', '/projects/art/app'].map(pulseOf)).toEqual(['tasks,changes', 'tasks,changes']);
    expect(['/p/tasks', '/p/tasks/task/t-1'].map(pulseOf)).toEqual(['tasks', 'tasks']);
    expect(['/', '/inbox', '/p/changesx'].map(pulseOf)).toEqual(['', '', '']);
  });

});
